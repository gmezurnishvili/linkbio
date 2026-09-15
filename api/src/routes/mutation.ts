import type { Context } from 'hono';
import { badRequest, versionConflict } from '../errors.ts';
import { cacheDimensionsFor } from '../publish.ts';
import type { Repo } from '../db/repo.ts';
import type { Block, Profile } from '../domain/types.ts';

/**
 * Every mutation response carries the new version and the new cache mask.
 *
 * The client keys its optimistic concurrency off the version and displays the
 * mask, and both are server-owned — a client writing against a stale version is
 * writing against a mask that no longer describes the page, which fails
 * silently rather than loudly.
 */
export type Mutation<T> = {
  data: T;
  version: number;
  cacheDimensions: string[];
};

export async function envelope<T>(repo: Repo, profileId: string, data: T): Promise<Mutation<T>> {
  const [profile, blocks] = await Promise.all([repo.getProfile(profileId), repo.listBlocks(profileId)]);
  return {
    data,
    version: profile?.version ?? 0,
    cacheDimensions: cacheDimensionsFor(blocks),
  };
}

/**
 * Reads the `If-Match` header.
 *
 * Optional, because the beacon and the public routes never send one and a
 * first-party script may not either. When present it must be a number, and a
 * malformed one is a client bug worth surfacing rather than silently ignoring —
 * ignoring it would turn a concurrency guarantee off without telling anyone.
 */
export function ifMatch(c: Context): number | undefined {
  const raw = c.req.header('if-match');
  if (raw === undefined || raw === '') return undefined;
  const v = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(v) || v < 0) throw badRequest('if-match must be a profile version');
  return v;
}

/**
 * The serialization point for every write to a profile.
 *
 * Bumping the profile version under a conditional write, before touching
 * anything else, means two concurrent writers cannot both proceed — which is
 * what stops two simultaneous block creates from computing the same rank and
 * wedging the list at that seam. It also gives the client a single version to
 * hold for the whole page, which is the model it already assumes.
 */
export async function gate(c: Context, repo: Repo, profile: Profile): Promise<Profile> {
  const expected = ifMatch(c);
  if (expected !== undefined && expected !== profile.version) throw versionConflict(profile.version);
  return repo.updateProfile(profile.id, {}, expected ?? profile.version);
}

/** A block as the API presents it — no internal fields, stable key order. */
export function publicBlock(b: Block) {
  return b;
}
