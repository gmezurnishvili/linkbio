import type { Block, DailyStat, Profile, User, RefreshRecord } from '../domain/types.ts';
import { TOMBSTONE_DAYS } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';
import {
  ConflictError, NotFoundError, VersionConflictError,
  type CreateProfileInput, type HandleState, type Repo,
} from './repo.ts';
import { newId } from '../ids.ts';
import { initialRanks } from '../rank.ts';

type HandleRow =
  | { kind: 'claim'; profileId: string }
  | { kind: 'tombstone'; profileId: string; until: number };

/**
 * Mirrors the DynamoDB implementation's semantics — same conflict conditions,
 * same sort ordering, same transactional grouping, same returned shapes —
 * without needing a running database.
 *
 * "Mirrors" used to be aspirational: this one freed a handle on rename while
 * Dynamo tombstoned it, kept working per-block totals Dynamo never wrote, and
 * returned clean objects where Dynamo returned raw items. A green suite
 * therefore certified behaviour production did not have, and one test asserted
 * the exact opposite of it. `test/conformance.test.ts` now runs the same cases
 * against both; anything added here belongs there too.
 */
export class MemoryRepo implements Repo {
  users = new Map<string, User>();
  emails = new Map<string, string>();
  refresh = new Map<string, RefreshRecord>();
  profiles = new Map<string, Profile>();
  handles = new Map<string, HandleRow>();
  blocks = new Map<string, Block>();
  daily = new Map<string, DailyStat>();
  totals = new Map<string, Record<string, number>>();

  private bk = (p: string, b: string) => `${p}|${b}`;
  private rk = (u: string, h: string) => `${u}|${h}`;
  private clone = <T>(v: T): T => structuredClone(v);

  // ---------------------------------------------------------------- users

  async createUser(email: string, passwordHash: string): Promise<User> {
    const e = email.toLowerCase();
    if (this.emails.has(e)) throw new ConflictError('that email is already registered');
    const u: User = { id: newId('u'), email: e, passwordHash, createdAt: Date.now() };
    this.users.set(u.id, u);
    this.emails.set(e, u.id);
    return this.clone(u);
  }

  async getUser(userId: string) {
    const u = this.users.get(userId);
    return u ? this.clone(u) : null;
  }

  async getUserByEmail(email: string) {
    const id = this.emails.get(email.toLowerCase());
    return id ? this.getUser(id) : null;
  }

  async putRefreshToken(rec: RefreshRecord) {
    this.refresh.set(this.rk(rec.userId, rec.tokenHash), this.clone(rec));
  }

  async consumeRefreshToken(userId: string, tokenHash: string) {
    const key = this.rk(userId, tokenHash);
    const rec = this.refresh.get(key);
    if (!rec) return null;
    this.refresh.delete(key); // single use, same as the conditional delete
    if (rec.expiresAt <= Date.now()) return null;
    return this.clone(rec);
  }

  async revokeRefreshTokens(userId: string) {
    for (const [k, v] of this.refresh) if (v.userId === userId) this.refresh.delete(k);
  }

  // ---------------------------------------------------------------- profiles

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const h = input.handle.toLowerCase();
    const state = await this.handleState(h);
    if (state.status !== 'free') throw new ConflictError(`handle ${h} is taken`);
    const now = Date.now();
    const p: Profile = {
      ...input, handle: h, id: newId('prof'),
      version: 1, publishedVersion: null, createdAt: now, updatedAt: now,
    };
    this.profiles.set(p.id, p);
    this.handles.set(h, { kind: 'claim', profileId: p.id });
    return this.clone(p);
  }

  async getProfile(id: string) {
    const p = this.profiles.get(id);
    return p ? this.clone(p) : null;
  }

  async getProfileByHandle(handle: string) {
    const row = this.handles.get(handle.toLowerCase());
    // A tombstone holds the name but does not resolve to a page.
    if (!row || row.kind !== 'claim') return null;
    return this.getProfile(row.profileId);
  }

  async handleState(handle: string): Promise<HandleState> {
    const row = this.handles.get(handle.toLowerCase());
    if (!row) return { status: 'free' };
    if (row.kind === 'tombstone') {
      if (row.until <= Date.now()) return { status: 'free' };
      return { status: 'tombstoned', profileId: row.profileId, until: row.until };
    }
    return { status: 'taken', profileId: row.profileId };
  }

  async listProfiles(userId: string) {
    return [...this.profiles.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(this.clone);
  }

  async updateProfile(id: string, patch: Partial<Profile>, expectedVersion?: number) {
    const p = this.profiles.get(id);
    if (!p) throw new NotFoundError(id);
    if (expectedVersion !== undefined && p.version !== expectedVersion) {
      throw new VersionConflictError(p.version);
    }
    const next: Profile = {
      ...p, ...patch,
      id: p.id, userId: p.userId, createdAt: p.createdAt,
      version: p.version + 1, updatedAt: Date.now(),
    };
    this.profiles.set(id, next);
    return this.clone(next);
  }

  async claimHandle(profileId: string, oldHandle: string, newHandle: string, expectedVersion?: number) {
    const h = newHandle.toLowerCase();
    const p = this.profiles.get(profileId);
    if (!p) throw new NotFoundError(profileId);
    if (expectedVersion !== undefined && p.version !== expectedVersion) {
      throw new VersionConflictError(p.version);
    }

    const state = await this.handleState(h);
    // A profile may reclaim a handle it gave up itself; nobody else may take it
    // until the tombstone expires.
    if (state.status !== 'free' && state.profileId !== profileId) {
      throw new ConflictError(`handle ${h} is taken`);
    }

    const old = oldHandle.toLowerCase();
    if (old && old !== h) {
      this.handles.set(old, {
        kind: 'tombstone', profileId, until: Date.now() + TOMBSTONE_DAYS * 86400_000,
      });
    }
    this.handles.set(h, { kind: 'claim', profileId });
    return this.updateProfile(profileId, { handle: h });
  }

  async deleteProfile(id: string) {
    const p = this.profiles.get(id);
    if (!p) return;
    for (const [k, row] of this.handles) if (row.profileId === id) this.handles.delete(k);
    this.profiles.delete(id);
    for (const [k, b] of this.blocks) if (b.profileId === id) this.blocks.delete(k);
    // The analytics partition goes with the profile — it outlived it before.
    for (const k of this.daily.keys()) if (k.startsWith(`${id}|`)) this.daily.delete(k);
    this.totals.delete(id);
  }

  // ---------------------------------------------------------------- blocks

  async listBlocks(profileId: string) {
    return [...this.blocks.values()]
      .filter((b) => b.profileId === profileId)
      .sort((a, b) => (`${a.rank}#${a.id}` < `${b.rank}#${b.id}` ? -1 : 1))
      .map(this.clone);
  }

  async getBlock(profileId: string, blockId: string) {
    const b = this.blocks.get(this.bk(profileId, blockId));
    return b ? this.clone(b) : null;
  }

  async putBlock(block: Block) {
    this.blocks.set(this.bk(block.profileId, block.id), this.clone(block));
    return this.clone(block);
  }

  async updateBlock(profileId: string, blockId: string, patch: Partial<Block>) {
    const b = this.blocks.get(this.bk(profileId, blockId));
    if (!b) throw new NotFoundError(blockId);
    const next = { ...b, ...patch, id: b.id, profileId: b.profileId, rank: b.rank, updatedAt: Date.now() };
    this.blocks.set(this.bk(profileId, blockId), next);
    return this.clone(next);
  }

  async moveBlock(profileId: string, blockId: string, newRank: string) {
    const b = this.blocks.get(this.bk(profileId, blockId));
    if (!b) throw new NotFoundError(blockId);
    if (b.rank === newRank) return this.clone(b);
    const next = { ...b, rank: newRank, updatedAt: Date.now() };
    this.blocks.set(this.bk(profileId, blockId), next);
    return this.clone(next);
  }

  async deleteBlock(profileId: string, blockId: string) {
    this.blocks.delete(this.bk(profileId, blockId));
  }

  async rebalanceBlocks(profileId: string) {
    const blocks = await this.listBlocks(profileId);
    if (!blocks.length) return blocks;
    const ranks = initialRanks(blocks.length);
    const next = blocks.map((b, i) => ({ ...b, rank: ranks[i]!, updatedAt: Date.now() }));
    for (const b of next) this.blocks.set(this.bk(profileId, b.id), b);
    return next.map(this.clone);
  }

  // ---------------------------------------------------------------- analytics

  async recordEvents(events: TClickEvent[], profileId: string) {
    for (const e of events) {
      const date = new Date(e.ts).toISOString().slice(0, 10);
      const key = `${profileId}|${date}`;
      const d = this.daily.get(key) ?? { date, views: 0, clicks: 0, byBlock: {} };
      if (e.blockId) {
        d.clicks++;
        d.byBlock[e.blockId] = (d.byBlock[e.blockId] ?? 0) + 1;
        const t = this.totals.get(profileId) ?? {};
        t[e.blockId] = (t[e.blockId] ?? 0) + 1;
        this.totals.set(profileId, t);
      } else {
        d.views++;
      }
      this.daily.set(key, d);
    }
  }

  async getDaily(profileId: string, from: string, to: string) {
    return [...this.daily.entries()]
      .filter(([k]) => k.startsWith(`${profileId}|`))
      .map(([, v]) => v)
      .filter((d) => d.date >= from && d.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map(this.clone);
  }

  async getBlockTotals(profileId: string) { return this.clone(this.totals.get(profileId) ?? {}); }

  async dueForRefresh(_shard: number, now: number, limit: number) {
    return [...this.blocks.values()]
      .filter((b) => b.kind === 'feed')
      // Keyed off the last fetch, not the last edit, so renaming a feed block
      // no longer pushes its refresh a full TTL into the future.
      .filter((b) => ((b.feedRefreshedAt ?? 0) + (b.feed?.ttlSeconds ?? 3600) * 1000) <= now)
      .slice(0, limit)
      .map(this.clone);
  }
}
