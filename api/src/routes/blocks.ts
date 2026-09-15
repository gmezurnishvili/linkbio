import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { BlockCreateChecked, BlockPatch, MoveBlock, RuleSet, checkBlockShape } from '../domain/schema.ts';
import { badRequest, conflict, fromRepo, notFound } from '../errors.ts';
import { RankExhausted, rankBetween } from '../rank.ts';
import { newId } from '../ids.ts';
import { publishMask } from '../publish.ts';
import { envelope, gate } from './mutation.ts';
import { env } from '../env.ts';
import { z } from 'zod';
import type { Block } from '../domain/types.ts';
import type { Env } from '../app.ts';

/**
 * Mounted as a child of the profiles router, so `requireAuth` and the ownership
 * check have already run and `c.get('profile')` is populated. Doing its own
 * lookup here is what made every block request pay for two JWT verifications
 * and two profile reads.
 */
export const blocks = new Hono<Env>();

const rethrow = (e: unknown): never => {
  const mapped = fromRepo(e);
  throw mapped ?? e;
};

/**
 * Republishes the edge mask after any change that could alter it.
 *
 * The mask carries the profile version, and that pairing is what lets the origin
 * spot a viewer whose cache key was built from an older mask and refuse to cache
 * the response. A publish failure is therefore the one thing that desynchronises
 * the edge from the rules — the rules route used to swallow it and answer 200,
 * so a KeyValueStore outage looked like success.
 */
async function republish(c: { var: Env['Variables'] }, profileId: string) {
  const profile = await c.var.repo.getProfile(profileId);
  if (!profile) throw notFound('profile not found');
  await publishMask(profile, await c.var.repo.listBlocks(profileId));
}

blocks.get('/', async (c) => c.json({ blocks: await c.var.repo.listBlocks(c.get('profile').id) }));

/**
 * Places a block between two neighbours, rebalancing the list if the seam has
 * run out of keys.
 *
 * There was no rebalance path at all before: `rankBetween` threw a bare
 * RangeError, which is not an ApiError, so the reorder surfaced as a 500 and
 * that position stayed unreorderable forever.
 */
async function rankAt(
  c: { var: Env['Variables'] },
  profileId: string,
  pick: (list: Block[]) => [string | null, string | null],
): Promise<string> {
  const list = await c.var.repo.listBlocks(profileId);
  try {
    return rankBetween(...pick(list));
  } catch (e) {
    if (!(e instanceof RankExhausted)) throw e;
    const rebalanced = await c.var.repo.rebalanceBlocks(profileId);
    return rankBetween(...pick(rebalanced));
  }
}

blocks.post('/', zValidator('json', BlockCreateChecked), async (c) => {
  const profile = c.get('profile');
  const profileId = profile.id;
  const body = c.req.valid('json');

  // The version gate runs first, so two concurrent creates cannot both read the
  // same tail rank and write it twice — which used to leave duplicate ranks and
  // wedge the next reorder across that pair.
  await gate(c, c.var.repo, profile).catch(rethrow);

  const existing = await c.var.repo.listBlocks(profileId);
  if (existing.length >= env.maxBlocks) throw conflict(`block limit of ${env.maxBlocks} reached`);
  if (body.after && !existing.some((b) => b.id === body.after)) {
    throw badRequest('after refers to an unknown block');
  }

  const rank = await rankAt(c, profileId, (list) => {
    if (!body.after) return [list.length ? list[list.length - 1]!.rank : null, null];
    const i = list.findIndex((b) => b.id === body.after);
    return [list[i]!.rank, list[i + 1]?.rank ?? null];
  });

  const now = Date.now();
  const block: Block = {
    id: newId('blk'),
    profileId,
    rank,
    kind: body.kind,
    label: body.label,
    target: body.target,
    icon: body.icon,
    hidden: body.hidden,
    activeFrom: body.activeFrom,
    activeUntil: body.activeUntil,
    rules: body.rules,
    feed: body.feed,
    createdAt: now,
    updatedAt: now,
  };
  await c.var.repo.putBlock(block);
  await republish(c, profileId);
  return c.json(await envelope(c.var.repo, profileId, block), 201);
});

blocks.patch('/:blockId', zValidator('json', BlockPatch), async (c) => {
  const profile = c.get('profile');
  const profileId = profile.id;
  const patch = c.req.valid('json');

  const current = await c.var.repo.getBlock(profileId, c.req.param('blockId'));
  if (!current) throw notFound('block not found');

  // Validated against what the block will become, not against the patch alone.
  // `BlockPatch` used to be built with `.innerType()`, which strips these
  // checks, so a PATCH could set activeUntil before activeFrom — hiding the
  // block permanently with nothing in the UI able to explain why — or clear a
  // link's target, after which the redirector 404s.
  const merged = { ...current, ...patch };
  const shape = z.object({}).superRefine((_v, ctx) => checkBlockShape(merged, ctx)).safeParse({});
  if (!shape.success) throw badRequest('invalid block', shape.error.issues);

  await gate(c, c.var.repo, profile).catch(rethrow);
  const updated = await c.var.repo.updateBlock(profileId, c.req.param('blockId'), patch).catch(rethrow);
  await republish(c, profileId);
  return c.json(await envelope(c.var.repo, profileId, updated));
});

blocks.put('/:blockId/rules', zValidator('json', RuleSet), async (c) => {
  const profile = c.get('profile');
  const profileId = profile.id;
  const rules = c.req.valid('json');

  await gate(c, c.var.repo, profile).catch(rethrow);
  const updated = await c.var.repo.updateBlock(profileId, c.req.param('blockId'), { rules }).catch(rethrow);
  // Deliberately not caught: a failed mask publish means the edge is now keyed
  // on the wrong dimensions, and reporting success would be a lie.
  await republish(c, profileId);
  return c.json(await envelope(c.var.repo, profileId, updated));
});

/**
 * Reorder. The new rank is the midpoint between the two neighbours the block is
 * landing between, so exactly one row is rewritten no matter how long the list.
 */
blocks.post('/:blockId/move', zValidator('json', MoveBlock), async (c) => {
  const profile = c.get('profile');
  const profileId = profile.id;
  const blockId = c.req.param('blockId');
  const { beforeId, afterId } = c.req.valid('json');

  if (!(await c.var.repo.getBlock(profileId, blockId))) throw notFound('block not found');
  await gate(c, c.var.repo, profile).catch(rethrow);

  const neighbours = (list: Block[]): [string | null, string | null] => {
    const others = list.filter((b) => b.id !== blockId);
    if (afterId) {
      const i = others.findIndex((b) => b.id === afterId);
      if (i === -1) throw badRequest('afterId refers to an unknown block');
      return [others[i]!.rank, others[i + 1]?.rank ?? null];
    }
    const i = others.findIndex((b) => b.id === beforeId);
    if (i === -1) throw badRequest('beforeId refers to an unknown block');
    return [others[i - 1]?.rank ?? null, others[i]!.rank];
  };

  const moved = await c.var.repo.moveBlock(profileId, blockId, await rankAt(c, profileId, neighbours));
  // A reorder cannot change the mask, but it does change the page, and without a
  // version bump `/p/:handle` keeps serving the old order until its TTL runs
  // out with nothing to signal otherwise. The gate above bumps it.
  await republish(c, profileId);
  return c.json(await envelope(c.var.repo, profileId, moved));
});

blocks.delete('/:blockId', async (c) => {
  const profile = c.get('profile');
  const profileId = profile.id;
  await gate(c, c.var.repo, profile).catch(rethrow);
  await c.var.repo.deleteBlock(profileId, c.req.param('blockId'));
  await republish(c, profileId);
  return c.body(null, 204);
});
