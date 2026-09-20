import { adapterFor, FeedNotConfigured, FeedRefUnusable, type AdapterCtx, type FeedItem } from './adapters.ts';
import { nextFeedDueAt, REFRESH_SHARDS, type Block } from '../domain/types.ts';
import { NotFoundError, type Repo } from '../db/repo.ts';
import { env } from '../env.ts';

/**
 * The consumer `dueForRefresh` never had.
 *
 * The index, the TTL and the block field have existed since the schema was
 * written; nothing ever walked them, so every feed block a creator added
 * rendered as nothing at all — `feedBlock` in the web renderer returns an empty
 * string for zero items, which is why it looked like the block had simply not
 * saved.
 *
 * Runs on a schedule rather than lazily on the render path. A cache miss on a
 * public page is already the slowest thing a visitor can do; making it also
 * wait on YouTube would put a third party in the critical path of a creator's
 * page, and a feed that times out would turn into a page that times out.
 */

export type RefreshOutcome =
  | { blockId: string; status: 'ok'; items: number }
  | { blockId: string; status: 'failed'; error: string; failures: number }
  | { blockId: string; status: 'unconfigured'; error: string };

export type RefreshSummary = {
  scanned: number;
  ok: number;
  failed: number;
  unconfigured: number;
  outcomes: RefreshOutcome[];
};

export type RefreshOptions = {
  now?: number;
  /** Per shard. */
  limit?: number;
  concurrency?: number;
  shards?: number[];
  ctx?: Partial<AdapterCtx>;
};

/** Fetches one block's feed and records the result, successful or not. */
export async function refreshBlock(
  repo: Repo,
  block: Block,
  opts: { now?: number; ctx?: Partial<AdapterCtx> } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? Date.now();
  const ctx: AdapterCtx = {
    limit: env.feedMaxItems,
    timeoutMs: env.feedTimeoutMs,
    maxBytes: env.feedMaxBytes,
    now,
    ...opts.ctx,
  };

  if (!block.feed) {
    // A block that lost its feed config is not an error to retry; it is a block
    // that should not be in the index. Recording an attempt takes it out.
    await save(repo, block, { feedAttemptedAt: now, feedFailures: 0, feedError: undefined });
    return { blockId: block.id, status: 'ok', items: block.items?.length ?? 0 };
  }

  try {
    const items = await adapterFor(block.feed.source).load(block.feed.ref, ctx);
    await save(repo, block, {
      items: items.slice(0, ctx.limit),
      feedRefreshedAt: now,
      feedAttemptedAt: now,
      feedFailures: 0,
      feedError: undefined,
    });
    return { blockId: block.id, status: 'ok', items: Math.min(items.length, ctx.limit) };
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 200);

    // A missing credential is an operator problem. Counting it as a block
    // failure would back the block off to daily and leave a stale error on the
    // creator's editor blaming them for it, so the attempt is recorded — the
    // block must leave the due window either way — and nothing else changes.
    if (e instanceof FeedNotConfigured) {
      await save(repo, block, { feedAttemptedAt: now });
      console.warn(JSON.stringify({ level: 'warn', msg: 'feed source not configured', blockId: block.id, source: block.feed.source }));
      return { blockId: block.id, status: 'unconfigured', error: message };
    }

    const failures = (block.feedFailures ?? 0) + 1;
    await save(repo, block, { feedAttemptedAt: now, feedFailures: failures, feedError: message });
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'feed refresh failed',
      blockId: block.id,
      source: block.feed.source,
      failures,
      permanent: e instanceof FeedRefUnusable,
      err: message,
    }));
    return { blockId: block.id, status: 'failed', error: message, failures };
  }
}

/**
 * A block can be edited or deleted between the index read and the write, and
 * the refresher is the one writer that must never turn that into a 500 or,
 * worse, resurrect a deleted row.
 */
async function save(repo: Repo, block: Block, patch: Partial<Block>): Promise<void> {
  try {
    await repo.updateBlock(block.profileId, block.id, patch);
  } catch (e) {
    if (e instanceof NotFoundError) return;
    throw e;
  }
}

/** Walks every shard of the refresh index and refreshes what is due. */
export async function refreshDue(repo: Repo, opts: RefreshOptions = {}): Promise<RefreshSummary> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? env.feedBatch;
  const concurrency = opts.concurrency ?? env.feedConcurrency;
  const shards = opts.shards ?? [...Array(REFRESH_SHARDS).keys()];

  const due: Block[] = [];
  for (const shard of shards) due.push(...(await repo.dueForRefresh(shard, now, limit)));

  const outcomes = await mapLimit(due, concurrency, (b) => refreshBlock(repo, b, { now, ctx: opts.ctx }));

  return {
    scanned: due.length,
    ok: outcomes.filter((o) => o.status === 'ok').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    unconfigured: outcomes.filter((o) => o.status === 'unconfigured').length,
    outcomes,
  };
}

/**
 * Bounded-concurrency map.
 *
 * `Promise.all` over a full batch would open one socket per block, which on a
 * shared host is how a refresher earns a rate limit for every creator at once.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export { nextFeedDueAt };
