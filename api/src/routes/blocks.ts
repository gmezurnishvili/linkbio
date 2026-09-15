import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { BlockCreate, BlockPatch, MoveBlock, RuleSet } from '../domain/schema.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { rankBetween } from '../rank.ts';
import { newId } from '../ids.ts';
import { publishMask } from '../publish.ts';
import { env } from '../env.ts';
import type { Block } from '../domain/types.ts';
import type { Env } from '../app.ts';

export const blocks = new Hono<Env>();

blocks.use('*', requireAuth, async (c, next) => {
  const p = await c.var.repo.getProfile(c.req.param('id')!);
  if (!p) throw notFound('profile not found');
  if (p.userId !== c.get('auth').userId) throw forbidden();
  c.set('profile', p);
  await next();
});

/**
 * Republishes the edge mask after any change that could alter it.
 *
 * The profile version is bumped first and the mask is published carrying that
 * version. That pairing is what lets the origin detect a viewer whose cache key
 * was built from an older mask and refuse to cache the response.
 */
async function republish(c: { var: Env['Variables'] }, profileId: string) {
  const profile = await c.var.repo.updateProfile(profileId, {});
  const all = await c.var.repo.listBlocks(profileId);
  await publishMask(profile, all);
}

blocks.get('/', async (c) => {
  return c.json({ blocks: await c.var.repo.listBlocks(c.req.param('id')!) });
});

blocks.post('/', zValidator('json', BlockCreate), async (c) => {
  const profileId = c.req.param('id')!;
  const body = c.req.valid('json');
  const existing = await c.var.repo.listBlocks(profileId);
  if (existing.length >= env.maxBlocks) throw conflict(`block limit of ${env.maxBlocks} reached`);

  // Append by default; `after` places the new block directly below that rank.
  let prev: string | null = existing.length ? existing[existing.length - 1].rank : null;
  let next: string | null = null;
  if (body.after) {
    const i = existing.findIndex((b) => b.id === body.after);
    if (i === -1) throw badRequest('after refers to an unknown block');
    prev = existing[i].rank;
    next = existing[i + 1]?.rank ?? null;
  }

  const now = Date.now();
  const block: Block = {
    id: newId('blk'),
    profileId,
    rank: rankBetween(prev, next),
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
  return c.json(block, 201);
});

blocks.patch('/:blockId', zValidator('json', BlockPatch), async (c) => {
  const profileId = c.req.param('id')!;
  const updated = await c.var.repo.updateBlock(profileId, c.req.param('blockId'), c.req.valid('json'))
    .catch(() => { throw notFound('block not found'); });
  await republish(c, profileId);
  return c.json(updated);
});

blocks.put('/:blockId/rules', zValidator('json', RuleSet), async (c) => {
  const profileId = c.req.param('id')!;
  const rules = c.req.valid('json');
  if (rules.length > env.maxRules) throw badRequest(`at most ${env.maxRules} rules per block`);
  const updated = await c.var.repo.updateBlock(profileId, c.req.param('blockId'), { rules })
    .catch(() => { throw notFound('block not found'); });
  const mask = await republish(c, profileId).then(() => undefined).catch(() => undefined);
  return c.json({ ...updated, mask });
});

/**
 * Reorder. The new rank is the midpoint between the two neighbours the block is
 * landing between, so exactly one row is rewritten no matter how long the list.
 */
blocks.post('/:blockId/move', zValidator('json', MoveBlock), async (c) => {
  const profileId = c.req.param('id')!;
  const blockId = c.req.param('blockId');
  const { beforeId, afterId } = c.req.valid('json');

  const list = (await c.var.repo.listBlocks(profileId)).filter((b) => b.id !== blockId);
  if (!(await c.var.repo.getBlock(profileId, blockId))) throw notFound('block not found');

  let prev: string | null = null;
  let next: string | null = null;
  if (afterId) {
    const i = list.findIndex((b) => b.id === afterId);
    if (i === -1) throw badRequest('afterId refers to an unknown block');
    prev = list[i].rank;
    next = list[i + 1]?.rank ?? null;
  } else if (beforeId) {
    const i = list.findIndex((b) => b.id === beforeId);
    if (i === -1) throw badRequest('beforeId refers to an unknown block');
    prev = list[i - 1]?.rank ?? null;
    next = list[i].rank;
  }

  const moved = await c.var.repo.moveBlock(profileId, blockId, rankBetween(prev, next));
  return c.json(moved);
});

blocks.delete('/:blockId', async (c) => {
  const profileId = c.req.param('id')!;
  await c.var.repo.deleteBlock(profileId, c.req.param('blockId'));
  await republish(c, profileId);
  return c.body(null, 204);
});
