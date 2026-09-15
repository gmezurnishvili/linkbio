import { Hono } from 'hono';
import { Handle } from '../domain/schema.ts';
import type { Env } from '../app.ts';

export const handles = new Hono<Env>();

/**
 * Handle availability, unauthenticated.
 *
 * The old version of this lived at `/v1/profiles/:id/handle/available`, under
 * the ownership middleware — which made it unreachable for the one thing it was
 * described as being for, checking a handle during signup, because there is no
 * profile id yet. It is a property of the namespace, not of a profile.
 */
handles.get('/:handle', async (c) => {
  const raw = c.req.param('handle').toLowerCase();

  const shape = Handle.safeParse(raw);
  if (!shape.success) {
    const reserved = shape.error.issues.some((i) => i.message === 'handle is reserved');
    return c.json({ available: false, reason: reserved ? 'reserved' : 'invalid' });
  }

  const state = await c.var.repo.handleState(raw);
  if (state.status === 'free') return c.json({ available: true });
  // "Tombstoned" reads as unavailable to everyone; the profile that gave it up
  // finds out it can still reclaim it by trying, which only it can do.
  return c.json({ available: false, reason: state.status === 'tombstoned' ? 'tombstoned' : 'taken' });
});
