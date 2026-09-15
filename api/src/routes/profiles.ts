import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { ClaimHandle, ProfileCreate, ProfilePatch } from '../domain/schema.ts';
import { requireAuth } from '../auth.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { ConflictError } from '../db/repo.ts';
import type { Env } from '../app.ts';

export const profiles = new Hono<Env>();

profiles.use('*', requireAuth);

profiles.get('/', async (c) => {
  const { userId } = c.get('auth');
  return c.json({ profiles: await c.var.repo.listProfiles(userId) });
});

profiles.post('/', zValidator('json', ProfileCreate), async (c) => {
  const { userId } = c.get('auth');
  const body = c.req.valid('json');
  try {
    const p = await c.var.repo.createProfile({ ...body, userId, handle: body.handle });
    return c.json(p, 201);
  } catch (e) {
    if (e instanceof ConflictError) throw conflict(e.message);
    throw e;
  }
});

/** Every profile route below resolves the profile and asserts ownership first. */
profiles.use('/:id/*', async (c, next) => {
  const p = await c.var.repo.getProfile(c.req.param('id'));
  if (!p) throw notFound('profile not found');
  if (p.userId !== c.get('auth').userId) throw forbidden();
  c.set('profile', p);
  await next();
});
profiles.use('/:id', async (c, next) => {
  const p = await c.var.repo.getProfile(c.req.param('id'));
  if (!p) throw notFound('profile not found');
  if (p.userId !== c.get('auth').userId) throw forbidden();
  c.set('profile', p);
  await next();
});

profiles.get('/:id', (c) => c.json(c.get('profile')));

profiles.patch('/:id', zValidator('json', ProfilePatch), async (c) => {
  const updated = await c.var.repo.updateProfile(c.req.param('id'), c.req.valid('json'));
  return c.json(updated);
});

profiles.delete('/:id', async (c) => {
  await c.var.repo.deleteProfile(c.req.param('id'));
  return c.body(null, 204);
});

profiles.put('/:id/handle', zValidator('json', ClaimHandle), async (c) => {
  const p = c.get('profile');
  const { handle } = c.req.valid('json');
  if (handle === p.handle) return c.json(p);
  try {
    const updated = await c.var.repo.claimHandle(p.id, p.handle, handle);
    return c.json(updated);
  } catch (e) {
    if (e instanceof ConflictError) throw conflict(e.message);
    throw e;
  }
});

/** Cheap pre-flight for the signup form so users learn about collisions early. */
profiles.get('/:id/handle/available', async (c) => {
  const q = c.req.query('handle') ?? '';
  const parsed = ClaimHandle.safeParse({ handle: q });
  if (!parsed.success) return c.json({ available: false, reason: 'invalid' });
  const taken = await c.var.repo.getProfileByHandle(parsed.data.handle);
  return c.json({ available: !taken || taken.id === c.req.param('id') });
});
