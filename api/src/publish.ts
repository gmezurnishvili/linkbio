import {
  CloudFrontKeyValueStoreClient, PutKeyCommand, DeleteKeyCommand, DescribeKeyValueStoreCommand,
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

/**
 * Publishes the mask for a profile. Deleting the key when the mask is empty
 * matters: a stale `mask:` entry keeps a profile paying for cache cardinality
 * it no longer uses, and the 5 MB store fills up fast.
 */
export async function publishMask(profile: Profile, blocks: Block[]): Promise<string> {
  const mask = deriveMask(blocks);
  if (!env.kvsArn) return mask; // local/dev: nothing to publish to

  const c = await kvs();
  const key = `mask:${profile.handle}`;
  try {
    const res = mask
      ? await c.send(new PutKeyCommand({
          KvsARN: env.kvsArn, IfMatch: etag!, Key: key, Value: `v${profile.version}|${mask}`,
        }))
      : await c.send(new DeleteKeyCommand({ KvsARN: env.kvsArn, IfMatch: etag!, Key: key }));
    etag = res.ETag ?? null;
  } catch (e) {
    // ETags move whenever anything else writes to the store, so one retry with
    // a fresh handle absorbs the normal concurrent-publish case.
    etag = null;
    if ((e as { name?: string }).name === 'ConflictException') return publishMask(profile, blocks);
    throw e;
  }
  return mask;
}

/** Mask characters the current rule set needs, for the origin's coverage check. */
export function maskDims(mask: string): Set<string> {
  const inv: Record<string, string> = { g: 'geo', d: 'device', r: 'referrer', l: 'lang', w: 'webview' };
  return new Set([...mask].map((ch) => inv[ch]).filter(Boolean));
}
