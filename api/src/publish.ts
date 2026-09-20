// CloudFront KeyValueStore signs with SigV4a, which the JS SDK does not ship in
// the client. The implementation registers itself into a container on import,
// so this side-effect import is the whole wiring — remove it and every call to
// the store throws "Neither CRT nor JS SigV4a implementation is available"
// before a request is ever sent. Both this package and `@smithy/signature-v4a`
// declare `sideEffects: true`, so esbuild keeps the import when bundling.
import '@aws-sdk/signature-v4a';
import {
  CloudFrontKeyValueStoreClient, DescribeKeyValueStoreCommand, UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import type { Block, Profile } from './domain/types.ts';
import { env } from './env.ts';

const DIM_CHAR: Record<string, string> = {
  geo: 'g', device: 'd', referrer: 'r', lang: 'l', webview: 'w',
};

/**
 * The set of dimensions the edge must fold into the cache key for this profile.
 *
 * Deriving it rather than asking creators to configure it is what keeps the
 * mask and the rules from drifting: the API is the only writer of both.
 * An empty mask is the common case and the cheap one — those profiles cache on
 * path alone and hit ~100%.
 */
export function deriveMask(blocks: Block[]): string {
  const dims = new Set<string>();
  for (const b of blocks) {
    for (const r of b.rules ?? []) {
      for (const c of r.when) {
        const ch = DIM_CHAR[c.dim];
        if (ch) dims.add(ch);
      }
    }
  }
  return [...'gdrlw'].filter((ch) => dims.has(ch)).join('');
}

// ---------------------------------------------------------------- hot links

/**
 * How many links per page the edge will answer without the origin.
 *
 * The KeyValueStore is 5 MB in total across every profile in the account, so
 * this is a shared budget, not a per-creator one. Twenty covers the entire link
 * list of a normal page; a creator with two hundred blocks gets the top twenty
 * served from the edge and the rest from the origin, which is the right way
 * round — rank order is roughly click order.
 */
export const MAX_HOT_LINKS = 20;

/**
 * A link whose destination cannot depend on who is asking, or when.
 *
 * That is the whole precondition for answering at the edge: no rules means no
 * context to evaluate, no activity window means no boundary to expire at, and a
 * published profile means `/r/` would have answered rather than 404ing. Miss
 * any one of those and the edge serves a constant where the origin computes a
 * variable — the same class of bug as the old positional `x-ctx` decoding, and
 * cached just as hard.
 */
export function isHotEligible(profile: Profile, b: Block): boolean {
  return (
    profile.publishedVersion !== null &&
    b.kind === 'link' &&
    !b.hidden &&
    (b.rules?.length ?? 0) === 0 &&
    b.activeFrom === undefined &&
    b.activeUntil === undefined &&
    typeof b.target === 'string' &&
    /^https?:\/\//i.test(b.target)
  );
}

export const hotKey = (handle: string, blockId: string) => `hot:${handle.toLowerCase()}/${blockId}`;
export const maskKey = (handle: string) => `mask:${handle.toLowerCase()}`;

/**
 * `<status>|<url>`, split on the first separator.
 *
 * The status leads because a URL may legally contain `|` in its query, and
 * splitting on every separator truncated exactly those targets. With the fixed
 * field first the format needs no escaping.
 */
export const hotValue = (target: string, status: 302 | 307 = 302) => `${status}|${target}`;

/** Every edge entry this profile should have right now. */
export function routingEntries(profile: Profile, blocks: Block[]): Map<string, string> {
  const out = new Map<string, string>();

  const mask = deriveMask(blocks);
  if (mask) out.set(maskKey(profile.handle), `v${profile.version}|${mask}`);

  if (env.hotLinks) {
    for (const b of blocks.filter((x) => isHotEligible(profile, x)).slice(0, MAX_HOT_LINKS)) {
      out.set(hotKey(profile.handle, b.id), hotValue(b.target!));
    }
  }
  return out;
}

/**
 * Keys that must not survive this publish.
 *
 * Derived rather than remembered. The alternative — storing the last published
 * key list on the profile — means a second write after every mutation, and that
 * write bumps the version, which is the value the client is holding as its
 * `If-Match`. Deriving costs a handful of idempotent deletes and keeps the
 * version meaning exactly one thing.
 */
export function staleKeys(
  profile: Profile,
  blocks: Block[],
  live: Map<string, string>,
  opts: { previousHandle?: string; removedBlockIds?: string[] } = {},
): string[] {
  const out = new Set<string>();
  const ids = [...blocks.map((b) => b.id), ...(opts.removedBlockIds ?? [])];

  // Anything on this handle that is not in the live set: a block that gained a
  // rule, went hidden, lost its target, fell past the cap, or was deleted. The
  // mask key too, for a profile whose last rule was just removed.
  for (const id of ids) {
    const key = hotKey(profile.handle, id);
    if (!live.has(key)) out.add(key);
  }
  if (!live.has(maskKey(profile.handle))) out.add(maskKey(profile.handle));

  // A rename leaves the whole of the old handle's routing behind, pointing at a
  // page that no longer answers there — and the next creator to claim that
  // handle inherits it. The mask key was already being orphaned this way before
  // hot links existed.
  const prev = opts.previousHandle?.toLowerCase();
  if (prev && prev !== profile.handle.toLowerCase()) {
    out.add(maskKey(prev));
    for (const id of ids) out.add(hotKey(prev, id));
  }

  return [...out];
}

// ---------------------------------------------------------------- transport

let client: CloudFrontKeyValueStoreClient | null = null;
let etag: string | null = null;

async function kvs() {
  if (!client) client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });
  if (!etag) {
    const d = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: env.kvsArn }));
    etag = d.ETag ?? null;
  }
  return client;
}

/** Keys per UpdateKeys call. A page at the hot-link cap fits in one. */
const BATCH = 50;

/**
 * Publishes a profile's edge routing: the cache-key mask and its hot links.
 *
 * Puts and deletes travel in the same `UpdateKeys` call, so the edge never sees
 * a state where the mask has moved to a renamed handle while the old hot links
 * are still answering under the old one.
 */
export async function publishRouting(
  profile: Profile,
  blocks: Block[],
  opts: { previousHandle?: string; removedBlockIds?: string[] } = {},
): Promise<{ mask: string; hot: number }> {
  const live = routingEntries(profile, blocks);
  const mask = deriveMask(blocks);
  const hot = [...live.keys()].filter((k) => k.startsWith('hot:')).length;
  if (!env.kvsArn) return { mask, hot }; // local/dev: nothing to publish to

  const puts = [...live].map(([Key, Value]) => ({ Key, Value }));
  const deletes = staleKeys(profile, blocks, live, opts).map((Key) => ({ Key }));

  for (let i = 0; i < Math.max(puts.length, deletes.length); i += BATCH) {
    await send({ Puts: puts.slice(i, i + BATCH), Deletes: deletes.slice(i, i + BATCH) });
  }
  return { mask, hot };
}

/** Removes every edge entry for a profile — on unpublish, or on delete. */
export async function retractRouting(profile: Profile, blocks: Block[]): Promise<void> {
  if (!env.kvsArn) return;
  const keys = [maskKey(profile.handle), ...blocks.map((b) => hotKey(profile.handle, b.id))];
  for (let i = 0; i < keys.length; i += BATCH) {
    await send({ Deletes: keys.slice(i, i + BATCH).map((Key) => ({ Key })) });
  }
}

async function send(
  body: { Puts?: { Key: string; Value: string }[]; Deletes?: { Key: string }[] },
  retried = false,
): Promise<void> {
  if (!body.Puts?.length && !body.Deletes?.length) return;
  const c = await kvs();
  try {
    const res = await c.send(new UpdateKeysCommand({ KvsARN: env.kvsArn, IfMatch: etag!, ...body }));
    etag = res.ETag ?? null;
  } catch (e) {
    // ETags move whenever anything else writes to the store, so one retry with
    // a fresh handle absorbs the ordinary concurrent-publish case. Retrying
    // once rather than recursing bounds it: unbounded recursion under sustained
    // contention is how `recordEvents` used to burn a Lambda timeout.
    etag = null;
    if (!retried && (e as { name?: string }).name === 'ConflictException') return send(body, true);
    throw e;
  }
}

/** The mask-only spelling, for callers and docs that predate hot links. */
export async function publishMask(profile: Profile, blocks: Block[]): Promise<string> {
  const { mask } = await publishRouting(profile, blocks);
  return mask;
}

/** Mask characters the current rule set needs, for the origin's coverage check. */
export function maskDims(mask: string): Set<string> {
  const inv: Record<string, string> = { g: 'geo', d: 'device', r: 'referrer', l: 'lang', w: 'webview' };
  return new Set([...mask].map((ch) => inv[ch]).filter(Boolean));
}

/**
 * The dimension names the editor displays, derived from the same blocks the
 * mask is. This is the authoritative `cacheDimensions` every mutation returns;
 * the client's own derivation exists only to warn about an unsaved edit.
 *
 * `time` is included when any rule has a time condition: a time window does not
 * enter the cache key, but it does bound the TTL, and the cost panel is about
 * both.
 */
export function cacheDimensionsFor(blocks: Block[]): string[] {
  const dims = [...maskDims(deriveMask(blocks))];
  const hasTime = blocks.some((b) => (b.rules ?? []).some((r) => r.when.some((c) => c.dim === 'time')));
  return hasTime ? [...dims, 'time'] : dims;
}
