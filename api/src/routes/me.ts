import { Hono } from 'hono';
import { requireAuth } from '../auth.ts';
import { unauthorized } from '../errors.ts';
import { cacheDimensionsFor } from '../publish.ts';
import type { Env } from '../app.ts';

export const me = new Hono<Env>();

/**
 * The signed-in user and their profiles, in one call.
 *
 * The dashboard needs both on first paint, and a profile list that arrives a
 * round trip after the session does is a visible flash of "no pages yet".
 */
me.get('/me', requireAuth, async (c) => {
  const { userId } = c.get('auth');
  const user = await c.var.repo.getUser(userId);
  // A valid token for a user that no longer exists: the account was deleted
  // while the token was still live.
  if (!user) throw unauthorized('no such user');

  const profiles = await c.var.repo.listProfiles(userId);
  const withDims = await Promise.all(profiles.map(async (p) => ({
    ...p,
    cacheDimensions: cacheDimensionsFor(await c.var.repo.listBlocks(p.id)),
  })));

  return c.json({
    userId: user.id,
    email: user.email,
    profiles: withDims,
  });
});
