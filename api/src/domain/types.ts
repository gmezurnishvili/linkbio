import type { TRule } from './schema.ts';

export type PageMode = 'standard' | 'event' | 'drop';

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number;
};

export type RefreshRecord = {
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
};

export type Profile = {
  id: string;
  userId: string;
  handle: string;
  title: string;
  bio?: string;
  avatarUrl?: string;
  eventAt?: number | null;
  /** Stored, not derived from `eventAt` — see `ProfileCreate` in ./schema.ts. */
  mode?: PageMode;
  theme?: Record<string, string>;
  version: number;
  /** The version last published. Null means the page has never been published. */
  publishedVersion: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Block = {
  id: string;
  profileId: string;
  rank: string;
  kind: 'link' | 'header' | 'embed' | 'feed';
  label: string;
  target?: string;
  icon?: string;
  hidden: boolean;
  activeFrom?: number | null;
  activeUntil?: number | null;
  rules: TRule[];
  feed?: { source: string; ref: string; ttlSeconds: number };
  items?: Array<{ title: string; subtitle?: string; href?: string }>;
  /**
   * When the feed last came back with items. Shown in the editor, and the thing
   * a creator actually wants to know: `feedAttemptedAt` moving while this does
   * not is exactly the shape of a feed that has quietly broken.
   */
  feedRefreshedAt?: number;
  /**
   * When the refresher last tried, successfully or not. The refresh index is
   * keyed off this rather than off `updatedAt`, so editing a block's label no
   * longer pushes its next refresh a full TTL into the future — and off the
   * attempt rather than the success, or a failing feed would stay permanently
   * due and be retried on every single run.
   */
  feedAttemptedAt?: number;
  /** Consecutive failures, which is what the backoff multiplier reads. */
  feedFailures?: number;
  /** The last failure, surfaced in the editor so a broken ref is visible. */
  feedError?: string;
  createdAt: number;
  updatedAt: number;
};

export type DailyStat = { date: string; views: number; clicks: number; byBlock: Record<string, number> };

/**
 * Single-table key layout.
 *
 * Analytics deliberately lives in `PROFILE#<id>#AN` rather than the profile's
 * own partition: a year of daily rollups would otherwise grow without bound in
 * the same partition that every cold page render has to read.
 */
export const K = {
  user: (userId: string) => ({ PK: `USER#${userId}`, SK: '#META' }),
  userEmail: (email: string) => ({ PK: `EMAIL#${email.toLowerCase()}`, SK: '#CLAIM' }),
  refresh: (userId: string, tokenHash: string) => ({ PK: `USER#${userId}`, SK: `RT#${tokenHash}` }),
  profile: (id: string) => ({ PK: `PROFILE#${id}`, SK: '#META' }),
  handle: (h: string) => ({ PK: `HANDLE#${h.toLowerCase()}`, SK: '#CLAIM' }),
  domain: (d: string) => ({ PK: `DOMAIN#${d.toLowerCase()}`, SK: '#CLAIM' }),
  block: (profileId: string, rank: string, blockId: string) => ({
    PK: `PROFILE#${profileId}`,
    SK: `BLOCK#${rank}#${blockId}`,
  }),
  blockPrefix: (profileId: string) => ({ PK: `PROFILE#${profileId}`, prefix: 'BLOCK#' }),
  analytics: (profileId: string) => `PROFILE#${profileId}#AN`,
  day: (date: string) => `DAY#${date}`,
  /** Per-block breakdown for one day. A row per block, not a map on the day row. */
  dayBlock: (date: string, blockId: string) => `DAY#${date}#B#${blockId}`,
  stat: (blockId: string) => `STAT#${blockId}`,
  gsi1Profile: (userId: string, createdAt: number) => ({
    GSI1PK: `USER#${userId}`,
    GSI1SK: `PROF#${createdAt}`,
  }),
  gsi2Refresh: (shard: number, dueAt: number) => ({
    GSI2PK: `REFRESH#${shard}`,
    GSI2SK: dueAt,
  }),
};

/** How long a handle released by a rename is held against the profile that gave it up. */
export const TOMBSTONE_DAYS = 90;

/** Daily rollups expire; all-time per-block totals do not. */
export const DAILY_RETENTION_DAYS = 400;

/**
 * When a feed block is next due.
 *
 * The backoff is the reason this is a function rather than an expression at the
 * two call sites: a feed that 404s has to stop being due every hour, but it
 * also has to keep trying, because the usual cause is a creator fixing the ref
 * in a minute's time. Doubling to a 16× ceiling takes an hourly feed to roughly
 * daily and no further.
 */
export const FEED_BACKOFF_CEILING = 16;

export function nextFeedDueAt(b: Pick<Block, 'feed' | 'feedAttemptedAt' | 'feedRefreshedAt' | 'feedFailures'>): number {
  const ttl = (b.feed?.ttlSeconds ?? 3600) * 1000;
  const last = b.feedAttemptedAt ?? b.feedRefreshedAt ?? 0;
  const factor = Math.min(2 ** (b.feedFailures ?? 0), FEED_BACKOFF_CEILING);
  return last + ttl * factor;
}

export const REFRESH_SHARDS = 10;
export const shardFor = (id: string) =>
  [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % REFRESH_SHARDS;
