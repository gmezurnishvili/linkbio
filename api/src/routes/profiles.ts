import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from './validate.ts';
import { ClaimHandle, ProfileCreate, ProfilePatch, VisitorContext } from '../domain/schema.ts';
import { requireAuth } from '../auth.ts';
import { forbidden, fromRepo, notFound } from '../errors.ts';
import { cacheDimensionsFor, publishRouting, retractRouting } from '../publish.ts';
import { resolveProfile } from '../resolve.ts';
import { envelope, ifMatch } from './mutation.ts';
import { blocks } from './blocks.ts';
import type { Env } from '../app.ts';

export const profiles = new Hono<Env>();

profiles.use('*', requireAuth);

const rethrow = (e: unknown): never => {
  const mapped = fromRepo(e);
  throw mapped ?? e;
};

profiles.get('/', async (c) => {
  const { userId } = c.get('auth');
  const list = await c.var.repo.listProfiles(userId);
  const withDims = await Promise.all(list.map(async (p) => ({
    ...p,
    cacheDimensions: cacheDimensionsFor(await c.var.repo.listBlocks(p.id)),
  })));
  return c.json({ profiles: withDims });
});

profiles.post('/', zValidator('json', ProfileCreate), async (c) => {
  const { userId } = c.get('auth');
  const body = c.req.valid('json');
  try {
    const p = await c.var.repo.createProfile({ ...body, userId, handle: body.handle });
    return c.json({ data: p, version: p.version, cacheDimensions: [] }, 201);
  } catch (e) {
    return rethrow(e);
  }
});

/**
 * Every profile route below resolves the profile and asserts ownership first.
 *
 * `/:id` and `/:id/*` are separate registrations because Hono matches them
 * separately. `/:id/*` also covers the blocks router mounted below, which is
 * the point: those routes no longer do their own lookup, so `requireAuth` and
 * this check each run once per request instead of twice.
 */
const own: MiddlewareHandler<Env> = async (c, next) => {
  const p = await c.var.repo.getProfile(c.req.param('id')!);
  if (!p) throw notFound('profile not found');
  if (p.userId !== c.get('auth').userId) throw forbidden();
  c.set('profile', p);
  await next();
};
profiles.use('/:id', own);
profiles.use('/:id/*', own);

profiles.get('/:id', async (c) => {
  const p = c.get('profile');
  const blocks = await c.var.repo.listBlocks(p.id);
  return c.json({ ...p, blocks, cacheDimensions: cacheDimensionsFor(blocks) });
});

profiles.patch('/:id', zValidator('json', ProfilePatch), async (c) => {
  try {
    const updated = await c.var.repo.updateProfile(c.req.param('id'), c.req.valid('json'), ifMatch(c));
    // The mask's value carries the profile version, and every profile write
    // bumps it. Without a republish here the edge keeps announcing the old
    // version, the origin reads that as a stale key and answers `no-store`, and
    // a page silently stops caching after its owner edits their bio.
    await publishRouting(updated, await c.var.repo.listBlocks(updated.id));
    return c.json(await envelope(c.var.repo, updated.id, updated));
  } catch (e) {
    return rethrow(e);
  }
});

profiles.delete('/:id', async (c) => {
  const p = c.get('profile');
  // Before the rows go, not after: the edge entries are the only thing that can
  // still answer for a handle whose profile no longer exists, and a hot link
  // left behind would keep redirecting to a deleted page's destination.
  await retractRouting(p, await c.var.repo.listBlocks(p.id));
  await c.var.repo.deleteProfile(p.id);
  return c.body(null, 204);
});

/**
 * Publishing is what makes a page live. Until then `publishedVersion` is null
 * and the public routes 404 — a draft nobody has chosen to show is not a page
 * that happens to be empty.
 */
profiles.post('/:id/publish', async (c) => {
  const p = c.get('profile');
  try {
    // `updateProfile` bumps the version as part of the same write, so the
    // version being published is the one this call produces, not the one we
    // read. Recording `p.version` left publishedVersion permanently one behind
    // and the editor permanently showing unpublished changes.
    const updated = await c.var.repo.updateProfile(p.id, { publishedVersion: p.version + 1 }, ifMatch(c));
    // The mask has to reach the edge before the page does, or the first viewer
    // is keyed on dimensions the rules no longer match.
    await publishRouting(updated, await c.var.repo.listBlocks(p.id));
    return c.json(await envelope(c.var.repo, p.id, updated));
  } catch (e) {
    return rethrow(e);
  }
});

/**
 * Take the page down without deleting it.
 *
 * `publishedVersion: null` is the same state a page has before its first
 * publish: the public routes 404 and the draft is untouched, so publishing
 * again puts back exactly what was there. Deleting was the only way to stop
 * serving a page until now, which is a very expensive way to take a weekend
 * off.
 *
 * The edge is retracted first, for the same reason delete does it first: a
 * mask or hot link left in the KeyValueStore is the one thing that can still
 * answer for a handle the origin has stopped serving.
 */
profiles.post('/:id/unpublish', async (c) => {
  const p = c.get('profile');
  try {
    await retractRouting(p, await c.var.repo.listBlocks(p.id));
    const updated = await c.var.repo.updateProfile(p.id, { publishedVersion: null }, ifMatch(c));
    return c.json(await envelope(c.var.repo, p.id, updated));
  } catch (e) {
    return rethrow(e);
  }
});

profiles.post('/:id/handle', zValidator('json', ClaimHandle), async (c) => {
  const p = c.get('profile');
  const { handle } = c.req.valid('json');
  if (handle === p.handle) return c.json(await envelope(c.var.repo, p.id, p));
  try {
    const updated = await c.var.repo.claimHandle(p.id, p.handle, handle, ifMatch(c));
    // The edge keys routing by handle, so a rename has to move it. Skipping
    // this orphaned `mask:<old>` under the old name — where the next creator to
    // claim it would inherit a cache-key mask derived from someone else's
    // rules — and left every hot link answering for a page that had moved.
    await publishRouting(updated, await c.var.repo.listBlocks(p.id), { previousHandle: p.handle });
    return c.json(await envelope(c.var.repo, p.id, updated));
  } catch (e) {
    return rethrow(e);
  }
});

// The dashboard sends POST; PUT is kept so an older client is not broken by the
// rename. Both are the same transactional claim.
profiles.put('/:id/handle', zValidator('json', ClaimHandle), async (c) => {
  const p = c.get('profile');
  const { handle } = c.req.valid('json');
  if (handle === p.handle) return c.json(await envelope(c.var.repo, p.id, p));
  try {
    const updated = await c.var.repo.claimHandle(p.id, p.handle, handle, ifMatch(c));
    // The edge keys routing by handle, so a rename has to move it. Skipping
    // this orphaned `mask:<old>` under the old name — where the next creator to
    // claim it would inherit a cache-key mask derived from someone else's
    // rules — and left every hot link answering for a page that had moved.
    await publishRouting(updated, await c.var.repo.listBlocks(p.id), { previousHandle: p.handle });
    return c.json(await envelope(c.var.repo, p.id, updated));
  } catch (e) {
    return rethrow(e);
  }
});

/**
 * Draft preview against an injected visitor context.
 *
 * Unlike the public resolve this reads unpublished state and returns the
 * decision trace, so the simulator can say *why* a block resolved the way it
 * did rather than only showing the result.
 */
profiles.post('/:id/preview', zValidator('json', VisitorContext), async (c) => {
  const p = c.get('profile');
  const blocks = await c.var.repo.listBlocks(p.id);
  const input = c.req.valid('json');
  return c.json(resolveProfile(p, blocks, input, { trace: true, draft: true }));
});

profiles.get('/:id/handle/available', async (c) => {
  const q = (c.req.query('handle') ?? '').toLowerCase();
  const parsed = ClaimHandle.safeParse({ handle: q });
  if (!parsed.success) return c.json({ available: false, reason: 'invalid' });
  const state = await c.var.repo.handleState(parsed.data.handle);
  if (state.status === 'free' || state.profileId === c.req.param('id')) return c.json({ available: true });
  return c.json({ available: false, reason: state.status });
});

/**
 * Blocks are mounted here, not separately in `app.ts`.
 *
 * Mounted at the top level they matched `profiles.use('/:id/*')` as well as
 * their own middleware, so every block request verified the JWT twice and read
 * the profile twice — five DynamoDB round trips for one `POST /blocks`. As a
 * child router they inherit `requireAuth` and `own` exactly once, and
 * `c.get('profile')` is already populated when they run.
 */
profiles.route('/:id/blocks', blocks);
