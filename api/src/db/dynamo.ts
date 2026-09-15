import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
  TransactWriteCommand, UpdateCommand, DeleteCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Block, DailyStat, Profile, User, RefreshRecord } from '../domain/types.ts';
import { K, shardFor, TOMBSTONE_DAYS, DAILY_RETENTION_DAYS } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';
import {
  ConflictError, NotFoundError, VersionConflictError,
  type CreateProfileInput, type HandleState, type Repo,
} from './repo.ts';
import { newId } from '../ids.ts';
import { initialRanks } from '../rank.ts';
import { env } from '../env.ts';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const T = env.tableName;

/**
 * Keys and bookkeeping attributes are stripped on the way out.
 *
 * Returning `r.Item` directly leaked PK, SK, GSI1PK, GSI1SK and `type` into
 * every API response — invisible in tests, because MemoryRepo returned clean
 * domain objects, so any assertion about response shape was checked against a
 * shape production did not produce.
 */
const INTERNAL = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'type', 'ttl']);

function strip<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!INTERNAL.has(k)) out[k] = v;
  return out as T;
}

const stripAll = <T>(items: Record<string, unknown>[] | undefined): T[] =>
  (items ?? []).map((i) => strip<T>(i)!).filter(Boolean);

const dayTtl = (date: string) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + DAILY_RETENTION_DAYS * 86400;

export class DynamoRepo implements Repo {
  // ---------------------------------------------------------------- users

  async createUser(email: string, passwordHash: string): Promise<User> {
    const u: User = { id: newId('u'), email: email.toLowerCase(), passwordHash, createdAt: Date.now() };
    try {
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.userEmail(u.email), userId: u.id, type: 'email' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { ...K.user(u.id), type: 'user', ...u },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
    } catch (e) {
      if (isTxnConflict(e)) throw new ConflictError('that email is already registered');
      throw e;
    }
    return u;
  }

  async getUser(userId: string) {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.user(userId) }));
    return strip<User>(r.Item);
  }

  async getUserByEmail(email: string) {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.userEmail(email) }));
    const id = r.Item?.userId as string | undefined;
    return id ? this.getUser(id) : null;
  }

  async putRefreshToken(rec: RefreshRecord) {
    await doc.send(new PutCommand({
      TableName: T,
      Item: {
        ...K.refresh(rec.userId, rec.tokenHash),
        type: 'refresh',
        ...rec,
        ttl: Math.floor(rec.expiresAt / 1000),
      },
    }));
  }

  /**
   * Single-use by construction: the delete is conditional on the row still
   * existing, so two concurrent refreshes with the same token cannot both win.
   * Token reuse is the signal that one has leaked.
   */
  async consumeRefreshToken(userId: string, tokenHash: string) {
    try {
      const r = await doc.send(new DeleteCommand({
        TableName: T,
        Key: K.refresh(userId, tokenHash),
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_OLD',
      }));
      const rec = strip<RefreshRecord>(r.Attributes);
      if (!rec || rec.expiresAt <= Date.now()) return null;
      return rec;
    } catch (e) {
      if (isCondFail(e)) return null;
      throw e;
    }
  }

  async revokeRefreshTokens(userId: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'RT#' },
    }));
    await batchDelete((r.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK })));
  }

  // ---------------------------------------------------------------- profiles

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const now = Date.now();
    const p: Profile = {
      ...input, handle: input.handle.toLowerCase(), id: newId('prof'),
      version: 1, publishedVersion: null, createdAt: now, updatedAt: now,
    };
    try {
      // The handle claim and the profile row must land together, otherwise a
      // crash between them leaves an orphaned reservation nobody can release.
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.handle(p.handle), profileId: p.id, type: 'handle' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { ...K.profile(p.id), ...K.gsi1Profile(p.userId, now), type: 'profile', ...p },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
    } catch (e: unknown) {
      if (isTxnConflict(e)) throw new ConflictError(`handle ${p.handle} is taken`);
      throw e;
    }
    return p;
  }

  async getProfile(id: string) {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.profile(id) }));
    return strip<Profile>(r.Item);
  }

  async getProfileByHandle(handle: string) {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.handle(handle) }));
    // A tombstone carries a profileId too, but the handle no longer resolves —
    // it is held only so nobody else can take it during the grace period.
    if (r.Item?.type !== 'handle') return null;
    const pid = r.Item?.profileId as string | undefined;
    return pid ? this.getProfile(pid) : null;
  }

  async handleState(handle: string): Promise<HandleState> {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.handle(handle) }));
    if (!r.Item) return { status: 'free' };
    if (r.Item.type === 'handle_tombstone') {
      const until = Number(r.Item.ttl ?? 0) * 1000;
      if (until <= Date.now()) return { status: 'free' };
      return { status: 'tombstoned', profileId: String(r.Item.profileId ?? ''), until };
    }
    return { status: 'taken', profileId: String(r.Item.profileId ?? '') };
  }

  async listProfiles(userId: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'PROF#' },
    }));
    return stripAll<Profile>(r.Items);
  }

  async updateProfile(id: string, patch: Partial<Profile>, expectedVersion?: number) {
    const { expr, names, values } = buildUpdate(patch, ['id', 'userId', 'createdAt', 'version']);
    const guarded = expectedVersion !== undefined;
    try {
      const r = await doc.send(new UpdateCommand({
        TableName: T,
        Key: K.profile(id),
        UpdateExpression: `SET ${expr.join(', ')}, #v = #v + :one, #ua = :now`,
        ConditionExpression: guarded
          ? 'attribute_exists(PK) AND #v = :ev'
          : 'attribute_exists(PK)',
        ExpressionAttributeNames: { ...names, '#v': 'version', '#ua': 'updatedAt' },
        ExpressionAttributeValues: {
          ...values, ':one': 1, ':now': Date.now(), ...(guarded ? { ':ev': expectedVersion } : {}),
        },
        ReturnValues: 'ALL_NEW',
      }));
      return strip<Profile>(r.Attributes)!;
    } catch (e) {
      if (!isCondFail(e)) throw e;
      // The condition covers two cases; ask which one it was.
      const cur = await this.getProfile(id);
      if (!cur) throw new NotFoundError(id);
      throw new VersionConflictError(cur.version);
    }
  }

  async claimHandle(profileId: string, oldHandle: string, newHandle: string, expectedVersion?: number) {
    const h = newHandle.toLowerCase();
    const guarded = expectedVersion !== undefined;
    try {
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.handle(h), profileId, type: 'handle' },
              // A profile may reclaim a handle it gave up itself; nobody else
              // may take it until the tombstone expires.
              ConditionExpression: 'attribute_not_exists(PK) OR profileId = :pid',
              ExpressionAttributeValues: { ':pid': profileId },
            },
          },
          // Tombstoned rather than deleted, so a rename cannot be used to hand
          // someone else's audience to a squatter who is watching for it.
          {
            Put: {
              TableName: T,
              Item: {
                ...K.handle(oldHandle), type: 'handle_tombstone', profileId,
                ttl: Math.floor(Date.now() / 1000) + TOMBSTONE_DAYS * 86400,
              },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.profile(profileId),
              UpdateExpression: 'SET handle = :h, version = version + :one, updatedAt = :now',
              ConditionExpression: guarded
                ? 'attribute_exists(PK) AND version = :ev'
                : 'attribute_exists(PK)',
              ExpressionAttributeValues: {
                ':h': h, ':one': 1, ':now': Date.now(), ...(guarded ? { ':ev': expectedVersion } : {}),
              },
            },
          },
        ],
      }));
    } catch (e) {
      if (isTxnConflict(e)) {
        if (guarded) {
          const cur = await this.getProfile(profileId);
          if (cur && cur.version !== expectedVersion) throw new VersionConflictError(cur.version);
        }
        throw new ConflictError(`handle ${h} is taken`);
      }
      throw e;
    }
    const p = await this.getProfile(profileId);
    if (!p) throw new NotFoundError(profileId);
    return p;
  }

  async deleteProfile(id: string) {
    const p = await this.getProfile(id);
    if (!p) return;
    const blocks = await this.listBlocks(id);
    await batchDelete(blocks.map((b) => K.block(id, b.rank, b.id)));

    // The analytics partition lives outside the profile's own, so deleting the
    // profile row leaves it behind. Daily rows carry a TTL, but all-time
    // STAT rows do not, and neither belongs to a deleted account.
    const an = await doc.send(new QueryCommand({
      TableName: T,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': K.analytics(id) },
    }));
    await batchDelete((an.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK })));

    await doc.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: T, Key: K.profile(id) } },
        { Delete: { TableName: T, Key: K.handle(p.handle) } },
      ],
    }));
  }

  // ---------------------------------------------------------------- blocks

  async listBlocks(profileId: string) {
    const out: Record<string, unknown>[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `PROFILE#${profileId}`, ':sk': 'BLOCK#' },
        ExclusiveStartKey: last,
      }));
      out.push(...(r.Items ?? []));
      last = r.LastEvaluatedKey;
    } while (last);
    return stripAll<Block>(out); // already in rank order — the sort key does the work
  }

  async getBlock(profileId: string, blockId: string) {
    const all = await this.listBlocks(profileId);
    return all.find((b) => b.id === blockId) ?? null;
  }

  async putBlock(block: Block) {
    await doc.send(new PutCommand({
      TableName: T,
      Item: {
        ...K.block(block.profileId, block.rank, block.id),
        type: 'block',
        ...block,
        ...(block.kind === 'feed'
          ? K.gsi2Refresh(shardFor(block.id), (block.feedRefreshedAt ?? 0) + (block.feed?.ttlSeconds ?? 3600) * 1000)
          : {}),
      },
    }));
    return block;
  }

  async updateBlock(profileId: string, blockId: string, patch: Partial<Block>) {
    const cur = await this.getBlock(profileId, blockId);
    if (!cur) throw new NotFoundError(blockId);
    const next = { ...cur, ...patch, id: cur.id, profileId, rank: cur.rank, updatedAt: Date.now() };
    await this.putBlock(next);
    return next;
  }

  async moveBlock(profileId: string, blockId: string, newRank: string) {
    const cur = await this.getBlock(profileId, blockId);
    if (!cur) throw new NotFoundError(blockId);
    if (cur.rank === newRank) return cur; // a transaction touching one item twice is rejected outright
    const next = { ...cur, rank: newRank, updatedAt: Date.now() };
    // Rank is part of the sort key, so the row has to be rewritten under a new
    // key. Transacting the pair keeps the block from vanishing mid-drag.
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: T, Key: K.block(profileId, cur.rank, blockId) } },
        {
          Put: {
            TableName: T,
            Item: { ...K.block(profileId, newRank, blockId), type: 'block', ...next },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
    return next;
  }

  async deleteBlock(profileId: string, blockId: string) {
    const cur = await this.getBlock(profileId, blockId);
    if (!cur) return;
    await doc.send(new DeleteCommand({ TableName: T, Key: K.block(profileId, cur.rank, blockId) }));
  }

  async rebalanceBlocks(profileId: string) {
    const blocks = await this.listBlocks(profileId);
    if (!blocks.length) return blocks;
    const ranks = initialRanks(blocks.length);
    const next = blocks.map((b, i) => ({ ...b, rank: ranks[i]!, updatedAt: Date.now() }));

    await batchDelete(blocks.map((b) => K.block(profileId, b.rank, b.id)));
    for (let i = 0; i < next.length; i += 25) {
      await doc.send(new BatchWriteCommand({
        RequestItems: {
          [T]: next.slice(i, i + 25).map((b) => ({
            PutRequest: { Item: { ...K.block(profileId, b.rank, b.id), type: 'block', ...b } },
          })),
        },
      }));
    }
    return next;
  }

  // ---------------------------------------------------------------- analytics

  /**
   * One row per (day) for the page totals, one per (day, block) for the
   * breakdown, one per block for the all-time total. Every counter is a
   * top-level `ADD`.
   *
   * The first version did `ADD byBlock.#b0 :n0 SET byBlock = ...` in a single
   * expression, which DynamoDB rejects twice over — `ADD` does not take nested
   * paths, and the two paths overlap — and whose error handler retried by
   * calling back into the same builder. Every click failed, and then recursed
   * until the Lambda timed out. Counters per row also keep a busy profile off
   * the 400 KB item ceiling, which a single map of block ids would hit at
   * around 5,000 blocks and never recover from.
   */
  async recordEvents(events: TClickEvent[], profileId: string) {
    const days = new Map<string, { views: number; clicks: number; byBlock: Map<string, number> }>();
    for (const e of events) {
      const date = new Date(e.ts).toISOString().slice(0, 10);
      const d = days.get(date) ?? { views: 0, clicks: 0, byBlock: new Map() };
      if (e.blockId) {
        d.clicks++;
        d.byBlock.set(e.blockId, (d.byBlock.get(e.blockId) ?? 0) + 1);
      } else d.views++;
      days.set(date, d);
    }

    const writes: Promise<unknown>[] = [];
    const totals = new Map<string, number>();

    for (const [date, d] of days) {
      writes.push(doc.send(new UpdateCommand({
        TableName: T,
        Key: { PK: K.analytics(profileId), SK: K.day(date) },
        UpdateExpression: 'ADD #views :v, #clicks :c SET #d = :date, #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#views': 'views', '#clicks': 'clicks', '#d': 'date', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':v': d.views, ':c': d.clicks, ':date': date, ':ttl': dayTtl(date) },
      })));

      for (const [blockId, n] of d.byBlock) {
        totals.set(blockId, (totals.get(blockId) ?? 0) + n);
        writes.push(doc.send(new UpdateCommand({
          TableName: T,
          Key: { PK: K.analytics(profileId), SK: K.dayBlock(date, blockId) },
          UpdateExpression: 'ADD #clicks :n SET #ttl = if_not_exists(#ttl, :ttl)',
          ExpressionAttributeNames: { '#clicks': 'clicks', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':n': n, ':ttl': dayTtl(date) },
        })));
      }
    }

    for (const [blockId, n] of totals) {
      writes.push(doc.send(new UpdateCommand({
        TableName: T,
        Key: { PK: K.analytics(profileId), SK: K.stat(blockId) },
        UpdateExpression: 'ADD #clicks :n',
        ExpressionAttributeNames: { '#clicks': 'clicks' },
        ExpressionAttributeValues: { ':n': n },
      })));
    }

    await Promise.all(writes);
  }

  async getDaily(profileId: string, from: string, to: string) {
    const rows: Record<string, unknown>[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: {
          ':pk': K.analytics(profileId), ':a': K.day(from), ':b': `${K.day(to)}￿`,
        },
        ExclusiveStartKey: last,
      }));
      rows.push(...(r.Items ?? []));
      last = r.LastEvaluatedKey;
    } while (last);

    const out = new Map<string, DailyStat>();
    const get = (date: string) => {
      const d = out.get(date) ?? { date, views: 0, clicks: 0, byBlock: {} };
      out.set(date, d);
      return d;
    };
    for (const i of rows) {
      const sk = String(i.SK);
      const [date = '', blockId] = sk.replace('DAY#', '').split('#B#');
      const d = get(date);
      if (blockId) d.byBlock[blockId] = (d.byBlock[blockId] ?? 0) + Number(i.clicks ?? 0);
      else {
        d.views += Number(i.views ?? 0);
        d.clicks += Number(i.clicks ?? 0);
      }
    }
    return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async getBlockTotals(profileId: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': K.analytics(profileId), ':sk': 'STAT#' },
    }));
    return Object.fromEntries(
      (r.Items ?? []).map((i) => [String(i.SK).replace('STAT#', ''), Number(i.clicks ?? 0)]),
    );
  }

  async dueForRefresh(shard: number, now: number, limit: number) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': `REFRESH#${shard}`, ':now': now },
      Limit: limit,
    }));
    return stripAll<Block>(r.Items);
  }
}

// ---------- helpers ----------

async function batchDelete(keys: Array<Record<string, unknown>>) {
  for (let i = 0; i < keys.length; i += 25) {
    await doc.send(new BatchWriteCommand({
      RequestItems: {
        [T]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
      },
    }));
  }
}

function buildUpdate(patch: Record<string, unknown>, skip: string[]) {
  const expr: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (skip.includes(k) || v === undefined) continue;
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    expr.push(`#k${i} = :v${i}`);
    i++;
  }
  if (!expr.length) { names['#noop'] = 'updatedAt'; values[':noop'] = Date.now(); expr.push('#noop = :noop'); }
  return { expr, names, values };
}

const isCondFail = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ConditionalCheckFailedException';

const isTxnConflict = (e: unknown) =>
  typeof e === 'object' && e !== null &&
  ((e as { name?: string }).name === 'TransactionCanceledException' || isCondFail(e));
