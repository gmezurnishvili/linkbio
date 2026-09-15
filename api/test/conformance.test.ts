import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const { MemoryRepo } = await import('../src/db/memory.ts');
const { ConflictError, NotFoundError, VersionConflictError } = await import('../src/db/repo.ts');
const { TOMBSTONE_DAYS } = await import('../src/domain/types.ts');

import type { Repo } from '../src/db/repo.ts';
import type { Block, Profile } from '../src/domain/types.ts';

/**
 * One suite of cases, run against a `Repo` implementation.
 *
 * ## Why this file exists
 *
 * `MemoryRepo` and `DynamoRepo` are required to behave identically, and they
 * did not. They diverged in five ways, every one of which the old suite was
 * blind to because it only ever exercised the memory one:
 *
 *   1. **Handle tombstones.** A rename freed the old handle in memory and
 *      tombstoned it for 90 days in DynamoDB. A test asserted the memory
 *      behaviour, so the suite was green while certifying the opposite of
 *      production.
 *   2. **All-time per-block totals.** Memory kept a working `totals` map;
 *      DynamoDB never wrote the `STAT#` rows at all, so the dashboard's
 *      per-block numbers were empty in production and correct in CI.
 *   3. **Event recording shape.** Memory folded per-block counts into a map on
 *      the day row; DynamoDB writes a row per block per day and reassembles
 *      the map on read. The two have to agree on the reassembled result.
 *   4. **Returned item shape.** DynamoDB returned raw items, leaking `PK`,
 *      `SK`, the GSI keys, `type` and `ttl` into API responses. Memory
 *      returned clean domain objects, so no assertion about response shape was
 *      ever checked against what production produced.
 *   5. **The analytics partition on delete.** Analytics lives outside the
 *      profile's own partition, so deleting the profile left it behind in
 *      DynamoDB while memory dropped it.
 *
 * ## Adding DynamoRepo
 *
 * Everything below goes through the `Repo` interface and the factory; nothing
 * reaches into an implementation's internals, and no case depends on another
 * case's state. Dropping in the second implementation is therefore meant to be
 * one call at the bottom of this file:
 *
 * ```ts
 * // With DynamoDB Local on :8000, or aws-sdk-client-mock in front of the SDK.
 * conformance('DynamoRepo', async () => new DynamoRepo());
 * ```
 *
 * The factory is async and returns a fresh, empty repository so a real backend
 * can create or truncate a table per run. The only thing a new implementation
 * must supply beyond that is isolation between cases — ids are generated, so
 * cases that share a table still do not collide.
 */
export function conformance(name: string, makeRepo: () => Promise<Repo>) {
  describe(`repo conformance: ${name}`, () => {
    let repo: Repo;
    beforeEach(async () => { repo = await makeRepo(); });

    const newProfile = (over: Partial<Profile> = {}) => repo.createProfile({
      userId: 'user_a', handle: 'alpha', title: 'Alpha', ...over,
    } as Parameters<Repo['createProfile']>[0]);

    const newBlock = (profileId: string, rank: string, over: Partial<Block> = {}): Block => ({
      id: over.id ?? `blk_${rank}`,
      profileId,
      rank,
      kind: 'link',
      label: over.label ?? `block ${rank}`,
      target: 'https://example.com/',
      hidden: false,
      rules: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    });

    const today = () => new Date().toISOString().slice(0, 10);

    // ------------------------------------------------------------ profiles

    describe('profiles', () => {
      test('a created profile is readable by id and by handle', async () => {
        const p = await newProfile();
        assert.equal(p.handle, 'alpha');
        assert.equal(p.version, 1);
        // A new page is a draft until someone publishes it.
        assert.equal(p.publishedVersion, null);
        assert.ok(p.id && p.createdAt && p.updatedAt);

        assert.deepEqual(await repo.getProfile(p.id), p);
        assert.deepEqual(await repo.getProfileByHandle('alpha'), p);
      });

      test('a handle is stored and matched lowercased', async () => {
        // The schema only ever passes a lowercase handle, but the namespace is
        // case-insensitive and the repository is what has to hold that line —
        // otherwise `Alpha` and `alpha` are two different pages.
        const p = await newProfile({ handle: 'MixedCase' });
        assert.equal(p.handle, 'mixedcase');
        assert.equal((await repo.getProfileByHandle('MIXEDCASE'))?.id, p.id);
        assert.equal((await repo.getProfileByHandle('mixedcase'))?.id, p.id);
        assert.equal(await repo.getProfileByHandle('alpha'), null);
      });

      test('a missing profile is null, not an error', async () => {
        assert.equal(await repo.getProfile('prof_nope'), null);
        assert.equal(await repo.getProfileByHandle('nobody'), null);
      });

      test('a returned profile carries no storage-internal fields', async () => {
        // DynamoRepo returned raw items, so PK/SK/GSI keys reached API
        // responses. Nothing outside the domain type may come back.
        const p = await newProfile() as Record<string, unknown>;
        for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'type', 'ttl']) {
          assert.equal(k in p, false, `${k} leaked out of the repository`);
        }
      });

      test('a second claim on the same handle conflicts', async () => {
        await newProfile();
        await assert.rejects(
          () => newProfile({ userId: 'user_b', title: 'Impostor' }),
          ConflictError,
        );
      });

      test('listProfiles returns only that user\'s profiles', async () => {
        const a1 = await newProfile({ handle: 'a-one' });
        const a2 = await newProfile({ handle: 'a-two' });
        const b1 = await newProfile({ handle: 'b-one', userId: 'user_b' });

        const mine = await repo.listProfiles('user_a');
        assert.deepEqual(new Set(mine.map((p) => p.id)), new Set([a1.id, a2.id]));

        const theirs = await repo.listProfiles('user_b');
        assert.deepEqual(theirs.map((p) => p.id), [b1.id]);

        assert.deepEqual(await repo.listProfiles('user_nobody'), []);
      });

      test('deleteProfile releases the handle and is idempotent', async () => {
        const p = await newProfile();
        await repo.deleteProfile(p.id);
        assert.equal(await repo.getProfile(p.id), null);
        assert.equal(await repo.getProfileByHandle('alpha'), null);
        assert.deepEqual(await repo.handleState('alpha'), { status: 'free' });
        await repo.deleteProfile(p.id); // deleting twice must not throw
      });
    });

    // ------------------------------------------------------------ updateProfile

    describe('updateProfile', () => {
      test('without an expected version it always applies and bumps', async () => {
        const p = await newProfile();
        const next = await repo.updateProfile(p.id, { title: 'Renamed' });
        assert.equal(next.title, 'Renamed');
        assert.equal(next.version, p.version + 1);
        assert.equal(next.id, p.id);
        assert.equal(next.createdAt, p.createdAt);
      });

      test('a correct expected version applies', async () => {
        const p = await newProfile();
        const next = await repo.updateProfile(p.id, { title: 'Ok' }, p.version);
        assert.equal(next.title, 'Ok');
        assert.equal(next.version, p.version + 1);
      });

      /**
       * A stale If-Match must write nothing and say what the current version
       * is, so the client can reload rather than guess. This is the difference
       * the routes turn into a `version_conflict` problem document, distinct
       * from a plain `conflict`.
       */
      test('a stale expected version writes nothing and reports the current one', async () => {
        const p = await newProfile();
        const bumped = await repo.updateProfile(p.id, { title: 'First' });

        await assert.rejects(
          () => repo.updateProfile(p.id, { title: 'Second' }, p.version),
          (e: unknown) => e instanceof VersionConflictError && e.current === bumped.version,
        );

        const now = await repo.getProfile(p.id);
        assert.equal(now!.title, 'First', 'the losing write must not have landed');
        assert.equal(now!.version, bumped.version, 'a rejected write must not bump the version');
      });

      test('cannot be used to rewrite identity', async () => {
        const p = await newProfile();
        const next = await repo.updateProfile(p.id, {
          id: 'prof_other', userId: 'user_b', createdAt: 1,
        } as Partial<Profile>);
        assert.equal(next.id, p.id);
        assert.equal(next.userId, p.userId);
        assert.equal(next.createdAt, p.createdAt);
      });

      test('a missing profile is a NotFoundError, not a silent create', async () => {
        await assert.rejects(() => repo.updateProfile('prof_nope', { title: 'x' }), NotFoundError);
        assert.equal(await repo.getProfile('prof_nope'), null);
      });

      test('publishing records the version that went live', async () => {
        const p = await newProfile();
        const published = await repo.updateProfile(p.id, { publishedVersion: p.version });
        assert.equal(published.publishedVersion, p.version);
        // And it survives later edits — a draft edit does not unpublish a page.
        const edited = await repo.updateProfile(p.id, { title: 'Edited' });
        assert.equal(edited.publishedVersion, p.version);
      });
    });

    // ------------------------------------------------------------ handles

    describe('handle state and renames', () => {
      test('handleState reports free and taken', async () => {
        assert.deepEqual(await repo.handleState('nobody-has-this'), { status: 'free' });
        const p = await newProfile();
        assert.deepEqual(await repo.handleState('alpha'), { status: 'taken', profileId: p.id });
      });

      test('handleState is case-insensitive', async () => {
        const p = await newProfile();
        assert.deepEqual(await repo.handleState('ALPHA'), { status: 'taken', profileId: p.id });
      });

      /**
       * The behaviour the two implementations disagreed on.
       *
       * A rename holds the old handle for 90 days so a rename cannot be used to
       * hand an established audience to a squatter watching for it.
       */
      test('a rename tombstones the old handle', async () => {
        const p = await newProfile();
        const renamed = await repo.claimHandle(p.id, 'alpha', 'beta');
        assert.equal(renamed.handle, 'beta');
        assert.equal(renamed.version, p.version + 1);

        const state = await repo.handleState('alpha');
        assert.equal(state.status, 'tombstoned');
        assert.equal(state.status === 'tombstoned' && state.profileId, p.id);
        // Roughly 90 days out — a day of slack, because the clock is real.
        const expected = Date.now() + TOMBSTONE_DAYS * 86400_000;
        assert.ok(
          state.status === 'tombstoned' && Math.abs(state.until - expected) < 86400_000,
          'tombstone should expire about 90 days out',
        );
      });

      test('a tombstoned handle does not resolve to a page', async () => {
        const p = await newProfile();
        await repo.claimHandle(p.id, 'alpha', 'beta');
        assert.equal(await repo.getProfileByHandle('alpha'), null);
        assert.equal((await repo.getProfileByHandle('beta'))?.id, p.id);
      });

      test('a third party cannot claim a tombstoned handle', async () => {
        const p = await newProfile();
        await repo.claimHandle(p.id, 'alpha', 'beta');

        // Not by creating a profile on it...
        await assert.rejects(
          () => repo.createProfile({
            userId: 'user_b', handle: 'alpha', title: 'Squatter',
          } as Parameters<Repo['createProfile']>[0]),
          ConflictError,
        );

        // ...and not by renaming onto it.
        const other = await repo.createProfile({
          userId: 'user_b', handle: 'gamma', title: 'Other',
        } as Parameters<Repo['createProfile']>[0]);
        await assert.rejects(() => repo.claimHandle(other.id, 'gamma', 'alpha'), ConflictError);
        assert.equal((await repo.getProfile(other.id))!.handle, 'gamma');
      });

      test('the profile that gave a handle up can reclaim it', async () => {
        const p = await newProfile();
        await repo.claimHandle(p.id, 'alpha', 'beta');
        const back = await repo.claimHandle(p.id, 'beta', 'alpha');
        assert.equal(back.handle, 'alpha');
        assert.equal((await repo.getProfileByHandle('alpha'))?.id, p.id);
        // And the handle it just left is now the tombstoned one.
        assert.equal((await repo.handleState('beta')).status, 'tombstoned');
      });

      test('a taken handle cannot be claimed by another profile', async () => {
        const a = await newProfile();
        const b = await repo.createProfile({
          userId: 'user_b', handle: 'gamma', title: 'Other',
        } as Parameters<Repo['createProfile']>[0]);
        await assert.rejects(() => repo.claimHandle(b.id, 'gamma', 'alpha'), ConflictError);
        assert.equal((await repo.getProfileByHandle('alpha'))?.id, a.id);
      });

      test('claimHandle honours a stale expected version', async () => {
        const p = await newProfile();
        const bumped = await repo.updateProfile(p.id, { title: 'Moved on' });
        await assert.rejects(
          () => repo.claimHandle(p.id, 'alpha', 'beta', p.version),
          (e: unknown) => e instanceof VersionConflictError && e.current === bumped.version,
        );
        assert.equal((await repo.getProfile(p.id))!.handle, 'alpha');
        assert.deepEqual(await repo.handleState('beta'), { status: 'free' });
      });

      test('claimHandle with a correct expected version applies', async () => {
        const p = await newProfile();
        const renamed = await repo.claimHandle(p.id, 'alpha', 'beta', p.version);
        assert.equal(renamed.handle, 'beta');
      });
    });

    // ------------------------------------------------------------ blocks

    describe('blocks', () => {
      test('put, get and list in rank order', async () => {
        const p = await newProfile();
        // Inserted out of order on purpose: the rank decides the order, not
        // the insertion sequence.
        await repo.putBlock(newBlock(p.id, 'c', { id: 'blk_c', label: 'third' }));
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a', label: 'first' }));
        await repo.putBlock(newBlock(p.id, 'b', { id: 'blk_b', label: 'second' }));

        const list = await repo.listBlocks(p.id);
        assert.deepEqual(list.map((b) => b.label), ['first', 'second', 'third']);

        const one = await repo.getBlock(p.id, 'blk_b');
        assert.equal(one?.label, 'second');
        assert.equal(await repo.getBlock(p.id, 'blk_nope'), null);
      });

      test('blocks are scoped to their profile', async () => {
        const a = await newProfile();
        const b = await newProfile({ handle: 'beta', userId: 'user_b' });
        await repo.putBlock(newBlock(a.id, 'a', { id: 'blk_mine' }));

        assert.deepEqual(await repo.listBlocks(b.id), []);
        assert.equal(await repo.getBlock(b.id, 'blk_mine'), null);
      });

      test('a returned block carries no storage-internal fields', async () => {
        const p = await newProfile();
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a' }));
        const b = (await repo.listBlocks(p.id))[0] as unknown as Record<string, unknown>;
        for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'type', 'ttl']) {
          assert.equal(k in b, false, `${k} leaked out of the repository`);
        }
      });

      test('updateBlock merges and cannot move the block', async () => {
        const p = await newProfile();
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a', label: 'before' }));
        const next = await repo.updateBlock(p.id, 'blk_a', { label: 'after', hidden: true });
        assert.equal(next.label, 'after');
        assert.equal(next.hidden, true);
        assert.equal(next.target, 'https://example.com/', 'untouched fields survive');
        assert.equal(next.id, 'blk_a');
        assert.equal(next.profileId, p.id);
        // Rank lives in the sort key; moving is `moveBlock`, not a patch.
        assert.equal(next.rank, 'a');
      });

      test('updateBlock on a missing block is a NotFoundError', async () => {
        const p = await newProfile();
        await assert.rejects(() => repo.updateBlock(p.id, 'blk_nope', { label: 'x' }), NotFoundError);
      });

      test('moveBlock reorders the list and rewrites one rank', async () => {
        const p = await newProfile();
        for (const [rank, id] of [['a', 'blk_a'], ['b', 'blk_b'], ['c', 'blk_c']] as const) {
          await repo.putBlock(newBlock(p.id, rank, { id, label: id }));
        }
        const moved = await repo.moveBlock(p.id, 'blk_c', '0');
        assert.equal(moved.rank, '0');
        assert.equal(moved.id, 'blk_c');

        const list = await repo.listBlocks(p.id);
        assert.deepEqual(list.map((b) => b.id), ['blk_c', 'blk_a', 'blk_b']);
        assert.equal(list.length, 3, 'a move is not a copy');
        assert.deepEqual(list.map((b) => b.rank), ['0', 'a', 'b']);
      });

      test('moving a block to the rank it already has is a no-op', async () => {
        const p = await newProfile();
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a' }));
        const same = await repo.moveBlock(p.id, 'blk_a', 'a');
        assert.equal(same.rank, 'a');
        assert.equal((await repo.listBlocks(p.id)).length, 1);
      });

      test('moveBlock on a missing block is a NotFoundError', async () => {
        const p = await newProfile();
        await assert.rejects(() => repo.moveBlock(p.id, 'blk_nope', 'z'), NotFoundError);
      });

      test('deleteBlock removes exactly one and is idempotent', async () => {
        const p = await newProfile();
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a' }));
        await repo.putBlock(newBlock(p.id, 'b', { id: 'blk_b' }));
        await repo.deleteBlock(p.id, 'blk_a');
        assert.deepEqual((await repo.listBlocks(p.id)).map((b) => b.id), ['blk_b']);
        await repo.deleteBlock(p.id, 'blk_a'); // deleting twice must not throw
        assert.equal((await repo.listBlocks(p.id)).length, 1);
      });

      /**
       * The escape hatch when a seam runs out of keys. Order is the whole
       * point: a rebalance that reshuffles the list is worse than the
       * exhaustion it is fixing.
       */
      test('rebalanceBlocks preserves order and re-seeds the ranks', async () => {
        const p = await newProfile();
        const ids = Array.from({ length: 40 }, (_, i) => `blk_${String(i).padStart(2, '0')}`);
        // Ranks that are legal but tightly packed, the way a long-lived list
        // ends up after many inserts at the same spot.
        for (const [i, id] of ids.entries()) {
          await repo.putBlock(newBlock(p.id, `0${String.fromCharCode(97 + i)}`, { id, label: id }));
        }
        const before = (await repo.listBlocks(p.id)).map((b) => b.id);

        const after = await repo.rebalanceBlocks(p.id);
        assert.deepEqual(after.map((b) => b.id), before, 'rebalance must not reorder');
        assert.deepEqual(
          (await repo.listBlocks(p.id)).map((b) => b.id), before,
          'the re-seeded ranks must sort back to the same order',
        );

        const ranks = after.map((b) => b.rank);
        assert.equal(new Set(ranks).size, ranks.length, 'duplicate rank after rebalance');
        assert.deepEqual(ranks, [...ranks].sort(), 'ranks are not ascending after rebalance');
      });

      test('rebalancing an empty list is empty', async () => {
        const p = await newProfile();
        assert.deepEqual(await repo.rebalanceBlocks(p.id), []);
      });

      /**
       * The refresh index is keyed off the last *fetch*, not the last edit, so
       * renaming a feed block no longer pushes its next refresh a full TTL
       * into the future.
       */
      test('dueForRefresh picks up stale feed blocks only', async () => {
        const p = await newProfile();
        const feed = { source: 'rss', ref: 'https://feed.example/rss', ttlSeconds: 3600 };
        await repo.putBlock(newBlock(p.id, 'a', {
          id: 'blk_stale', kind: 'feed', feed, feedRefreshedAt: Date.now() - 2 * 3600_000,
        }));
        await repo.putBlock(newBlock(p.id, 'b', {
          id: 'blk_fresh', kind: 'feed', feed, feedRefreshedAt: Date.now(),
        }));
        await repo.putBlock(newBlock(p.id, 'c', { id: 'blk_link' }));

        const due = await repo.dueForRefresh(0, Date.now(), 10);
        const ids = due.map((b) => b.id);
        assert.ok(ids.includes('blk_stale'));
        assert.ok(!ids.includes('blk_fresh'));
        assert.ok(!ids.includes('blk_link'), 'only feed blocks are refreshable');
      });
    });

    // ------------------------------------------------------------ analytics

    describe('analytics', () => {
      test('recordEvents feeds getDaily and getBlockTotals consistently', async () => {
        const p = await newProfile();
        const ts = Date.now();
        await repo.recordEvents([
          { handle: 'alpha', blockId: 'blk_a', ts },
          { handle: 'alpha', blockId: 'blk_a', ts },
          { handle: 'alpha', blockId: 'blk_b', ts },
          { handle: 'alpha', ts }, // no blockId — a page view
        ], p.id);

        const daily = await repo.getDaily(p.id, today(), today());
        assert.equal(daily.length, 1);
        assert.equal(daily[0]!.date, today());
        assert.equal(daily[0]!.views, 1);
        assert.equal(daily[0]!.clicks, 3);
        assert.deepEqual(daily[0]!.byBlock, { blk_a: 2, blk_b: 1 });

        // The day rows and the all-time rows are written separately; they have
        // to add up to the same thing.
        assert.deepEqual(await repo.getBlockTotals(p.id), { blk_a: 2, blk_b: 1 });
      });

      test('repeated batches accumulate rather than replace', async () => {
        const p = await newProfile();
        const ts = Date.now();
        await repo.recordEvents([{ handle: 'alpha', blockId: 'blk_a', ts }], p.id);
        await repo.recordEvents([{ handle: 'alpha', blockId: 'blk_a', ts }], p.id);

        const daily = await repo.getDaily(p.id, today(), today());
        assert.equal(daily[0]!.clicks, 2);
        assert.deepEqual(daily[0]!.byBlock, { blk_a: 2 });
        assert.deepEqual(await repo.getBlockTotals(p.id), { blk_a: 2 });
      });

      test('getDaily is bounded by the range and sorted ascending', async () => {
        const p = await newProfile();
        const day = (back: number) => Date.now() - back * 86_400_000;
        const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
        await repo.recordEvents([
          { handle: 'alpha', ts: day(3) },
          { handle: 'alpha', ts: day(1) },
          { handle: 'alpha', ts: day(0) },
        ], p.id);

        const inRange = await repo.getDaily(p.id, iso(day(2)), iso(day(0)));
        assert.deepEqual(inRange.map((d) => d.date), [iso(day(1)), iso(day(0))]);

        const none = await repo.getDaily(p.id, '1999-01-01', '1999-12-31');
        assert.deepEqual(none, []);
      });

      test('analytics are partitioned per profile', async () => {
        const a = await newProfile();
        const b = await newProfile({ handle: 'beta', userId: 'user_b' });
        await repo.recordEvents([{ handle: 'alpha', blockId: 'blk_a', ts: Date.now() }], a.id);

        assert.deepEqual(await repo.getBlockTotals(b.id), {});
        assert.deepEqual(await repo.getDaily(b.id, today(), today()), []);
      });

      test('an empty profile reports empty analytics, not an error', async () => {
        const p = await newProfile();
        assert.deepEqual(await repo.getDaily(p.id, today(), today()), []);
        assert.deepEqual(await repo.getBlockTotals(p.id), {});
      });

      /**
       * Analytics deliberately live outside the profile's own partition, which
       * is why deleting the profile used to leave a year of rollups and every
       * all-time counter behind.
       */
      test('deleteProfile clears blocks and the analytics partition', async () => {
        const p = await newProfile();
        await repo.putBlock(newBlock(p.id, 'a', { id: 'blk_a' }));
        await repo.recordEvents([
          { handle: 'alpha', blockId: 'blk_a', ts: Date.now() },
          { handle: 'alpha', ts: Date.now() },
        ], p.id);

        await repo.deleteProfile(p.id);

        assert.deepEqual(await repo.listBlocks(p.id), []);
        assert.deepEqual(await repo.getDaily(p.id, '2000-01-01', '2100-01-01'), []);
        assert.deepEqual(await repo.getBlockTotals(p.id), {});
      });
    });

    // ------------------------------------------------------------ users

    describe('users', () => {
      test('a created user is readable by id and by email', async () => {
        const u = await repo.createUser('Person@Example.com', 'hash$1');
        assert.ok(u.id);
        // Stored lowercased, or the same person registers twice.
        assert.equal(u.email, 'person@example.com');
        assert.equal(u.passwordHash, 'hash$1');

        assert.deepEqual(await repo.getUser(u.id), u);
        assert.deepEqual(await repo.getUserByEmail('person@example.com'), u);
        assert.deepEqual(await repo.getUserByEmail('PERSON@EXAMPLE.COM'), u);
      });

      test('a missing user is null', async () => {
        assert.equal(await repo.getUser('u_nope'), null);
        assert.equal(await repo.getUserByEmail('nobody@example.com'), null);
      });

      test('a duplicate email conflicts, whatever its case', async () => {
        await repo.createUser('person@example.com', 'hash$1');
        await assert.rejects(
          () => repo.createUser('Person@Example.com', 'hash$2'),
          ConflictError,
        );
        // And the first registration is untouched.
        assert.equal((await repo.getUserByEmail('person@example.com'))!.passwordHash, 'hash$1');
      });
    });

    // ------------------------------------------------------------ refresh tokens

    describe('refresh tokens', () => {
      const rec = (over: Record<string, unknown> = {}) => ({
        userId: 'u_1',
        tokenHash: 'hash-of-the-secret-half',
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        ...over,
      });

      test('a stored token can be consumed once', async () => {
        const r = rec();
        await repo.putRefreshToken(r);
        const got = await repo.consumeRefreshToken(r.userId, r.tokenHash);
        assert.equal(got?.userId, 'u_1');
        assert.equal(got?.tokenHash, r.tokenHash);
      });

      /**
       * Rotation is only meaningful if consumption is single-use: a second use
       * of the same token is the signal that one leaked.
       */
      test('a second use of the same token returns null', async () => {
        const r = rec();
        await repo.putRefreshToken(r);
        assert.ok(await repo.consumeRefreshToken(r.userId, r.tokenHash));
        assert.equal(await repo.consumeRefreshToken(r.userId, r.tokenHash), null);
      });

      test('an unknown token returns null', async () => {
        assert.equal(await repo.consumeRefreshToken('u_1', 'never-stored'), null);
      });

      test('an expired token returns null', async () => {
        const r = rec({ expiresAt: Date.now() - 1000 });
        await repo.putRefreshToken(r);
        assert.equal(await repo.consumeRefreshToken(r.userId, r.tokenHash), null);
      });

      test('a token cannot be consumed by another user', async () => {
        const r = rec();
        await repo.putRefreshToken(r);
        assert.equal(await repo.consumeRefreshToken('u_2', r.tokenHash), null);
      });

      test('revoke drops every token for that user and nobody else\'s', async () => {
        const mine1 = rec({ tokenHash: 'h1' });
        const mine2 = rec({ tokenHash: 'h2' });
        const theirs = rec({ userId: 'u_2', tokenHash: 'h3' });
        for (const r of [mine1, mine2, theirs]) await repo.putRefreshToken(r);

        await repo.revokeRefreshTokens('u_1');
        assert.equal(await repo.consumeRefreshToken('u_1', 'h1'), null);
        assert.equal(await repo.consumeRefreshToken('u_1', 'h2'), null);
        assert.ok(await repo.consumeRefreshToken('u_2', 'h3'), 'another user kept their session');
      });
    });
  });
}

conformance('MemoryRepo', async () => new MemoryRepo());

// Drop the second implementation in here once DynamoDB Local (or
// aws-sdk-client-mock) is wired up. Nothing above needs to change:
//
//   const { DynamoRepo } = await import('../src/db/dynamo.ts');
//   conformance('DynamoRepo', async () => { await resetTable(); return new DynamoRepo(); });
