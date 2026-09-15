import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
  TransactWriteCommand, UpdateCommand, DeleteCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Block, DailyStat, Profile } from '../domain/types.ts';
import { K, shardFor } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';
import { ConflictError, NotFoundError, type CreateProfileInput, type Repo } from './repo.ts';
import { newId } from '../ids.ts';
import { env } from '../env.ts';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const T = env.tableName;

export class DynamoRepo implements Repo {
  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const now = Date.now();
    const p: Profile = {
      ...input, handle: input.handle.toLowerCase(), id: newId('prof'),
      version: 1, createdAt: now, updatedAt: now,
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
    return (r.Item as Profile | undefined) ?? null;
  }

  async getProfileByHandle(handle: string) {
    const r = await doc.send(new GetCommand({ TableName: T, Key: K.handle(handle) }));
    const pid = r.Item?.profileId as string | undefined;
    return pid ? this.getProfile(pid) : null;
  }

  async listProfiles(userId: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'PROF#' },
    }));
    return (r.Items ?? []) as Profile[];
  }

  async updateProfile(id: string, patch: Partial<Profile>) {
    const { expr, names, values } = buildUpdate(patch, ['id', 'userId', 'createdAt', 'version']);
    const r = await doc.send(new UpdateCommand({
      TableName: T,
      Key: K.profile(id),
      UpdateExpression: `SET ${expr.join(', ')}, #v = #v + :one, #ua = :now`,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { ...names, '#v': 'version', '#ua': 'updatedAt' },
      ExpressionAttributeValues: { ...values, ':one': 1, ':now': Date.now() },
      ReturnValues: 'ALL_NEW',
    })).catch((e) => { throw isCondFail(e) ? new NotFoundError(id) : e; });
    return r.Attributes as Profile;
  }

  async claimHandle(profileId: string, oldHandle: string, newHandle: string) {
    const h = newHandle.toLowerCase();
    try {
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { ...K.handle(h), profileId, type: 'handle' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          // Tombstone the old handle with a TTL so existing links can 301 for a
          // grace period instead of 404ing the moment someone renames.
          {
            Put: {
              TableName: T,
              Item: {
                ...K.handle(oldHandle), type: 'handle_tombstone', redirectTo: h,
                ttl: Math.floor(Date.now() / 1000) + 90 * 86400,
              },
            },
          },
          {
            Update: {
              TableName: T,
              Key: K.profile(profileId),
              UpdateExpression: 'SET handle = :h, version = version + :one, updatedAt = :now',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':h': h, ':one': 1, ':now': Date.now() },
            },
          },
        ],
      }));
    } catch (e) {
      if (isTxnConflict(e)) throw new ConflictError(`handle ${h} is taken`);
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
    for (let i = 0; i < blocks.length; i += 25) {
      await doc.send(new BatchWriteCommand({
        RequestItems: {
          [T]: blocks.slice(i, i + 25).map((b) => ({
            DeleteRequest: { Key: K.block(id, b.rank, b.id) },
          })),
        },
      }));
    }
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: T, Key: K.profile(id) } },
        { Delete: { TableName: T, Key: K.handle(p.handle) } },
      ],
    }));
  }

  async listBlocks(profileId: string) {
    const out: Block[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `PROFILE#${profileId}`, ':sk': 'BLOCK#' },
        ExclusiveStartKey: last,
      }));
      out.push(...((r.Items ?? []) as Block[]));
      last = r.LastEvaluatedKey;
    } while (last);
    return out; // already in rank order — the sort key does the work
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
          ? K.gsi2Refresh(shardFor(block.id), Date.now() + (block.feed?.ttlSeconds ?? 3600) * 1000)
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

  async recordEvents(events: TClickEvent[], profileId: string) {
    // Aggregated in-process before writing: one UpdateItem per (day, block)
    // instead of one per click. The Firehose consumer batches far harder still.
    const byDay = new Map<string, { views: number; clicks: number; byBlock: Map<string, number> }>();
    for (const e of events) {
      const date = new Date(e.ts).toISOString().slice(0, 10);
      const d = byDay.get(date) ?? { views: 0, clicks: 0, byBlock: new Map() };
      if (e.blockId) {
        d.clicks++;
        d.byBlock.set(e.blockId, (d.byBlock.get(e.blockId) ?? 0) + 1);
      } else d.views++;
      byDay.set(date, d);
    }
    await Promise.all([...byDay].map(([date, d]) => {
      const names: Record<string, string> = {};
      const values: Record<string, number> = { ':v': d.views, ':c': d.clicks, ':z': 0 };
      const adds = ['#views :v', '#clicks :c'];
      names['#views'] = 'views';
      names['#clicks'] = 'clicks';
      let i = 0;
      for (const [bid, n] of d.byBlock) {
        names[`#b${i}`] = bid;
        values[`:n${i}`] = n;
        adds.push(`byBlock.#b${i} :n${i}`);
        i++;
      }
      return doc.send(new UpdateCommand({
        TableName: T,
        Key: { PK: K.analytics(profileId), SK: K.day(date) },
        UpdateExpression: `ADD ${adds.join(', ')} SET #bb = if_not_exists(#bb, :empty)`,
        ExpressionAttributeNames: { ...names, '#bb': 'byBlock' },
        ExpressionAttributeValues: { ...values, ':empty': {} },
      })).catch(() => this.recordEventsFallback(profileId, date, d));
    }));
  }

  /** ADD into a nested map fails if the map does not exist yet; seed then retry. */
  private async recordEventsFallback(
    profileId: string, date: string,
    d: { views: number; clicks: number; byBlock: Map<string, number> },
  ) {
    await doc.send(new UpdateCommand({
      TableName: T,
      Key: { PK: K.analytics(profileId), SK: K.day(date) },
      UpdateExpression: 'SET byBlock = if_not_exists(byBlock, :empty), #d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':empty': {}, ':date': date },
    }));
    await this.recordEvents(
      [...d.byBlock].flatMap(([bid, n]) =>
        Array.from({ length: n }, () => ({ handle: '', blockId: bid, ts: Date.parse(date) }))),
      profileId,
    );
  }

  async getDaily(profileId: string, from: string, to: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':pk': K.analytics(profileId), ':a': K.day(from), ':b': K.day(to),
      },
    }));
    return (r.Items ?? []).map((i) => ({
      date: i.SK.replace('DAY#', ''),
      views: i.views ?? 0,
      clicks: i.clicks ?? 0,
      byBlock: i.byBlock ?? {},
    })) as DailyStat[];
  }

  async getBlockTotals(profileId: string) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': K.analytics(profileId), ':sk': 'STAT#' },
    }));
    return Object.fromEntries((r.Items ?? []).map((i) => [i.SK.replace('STAT#', ''), i.clicks ?? 0]));
  }

  async dueForRefresh(shard: number, now: number, limit: number) {
    const r = await doc.send(new QueryCommand({
      TableName: T,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
      ExpressionAttributeValues: { ':pk': `REFRESH#${shard}`, ':now': now },
      Limit: limit,
    }));
    return (r.Items ?? []) as Block[];
  }
}

// ---------- helpers ----------

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
