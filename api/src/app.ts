import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import { bodyLimit } from 'hono/body-limit';
import { notFound, onError, tooLarge } from './errors.ts';
import { env } from './env.ts';
import { auth } from './routes/auth.ts';
import { me } from './routes/me.ts';
import { handles } from './routes/handles.ts';
import { profiles } from './routes/profiles.ts';
import { publicRoutes } from './routes/public.ts';
import { analytics } from './routes/analytics.ts';
import type { Repo } from './db/repo.ts';
import type { Profile } from './domain/types.ts';

export type Env = {
  Variables: {
    repo: Repo;
    profile: Profile;
  };
};

/**
 * Only the click beacon is reachable from a browser on another origin. The
 * dashboard talks to this API through its own server-side proxy, so it is
 * same-origin from here and needs nothing.
 */
const BEACON_PATHS = ['/v1/events'];

export function createApp(repo: Repo) {
  const app = new Hono<Env>();

  app.use('*', requestId());
  app.use('*', logger());
  app.use('*', secureHeaders());

  // Zod caps individual fields, but only after the whole body has been parsed.
  app.use('*', bodyLimit({ maxSize: env.maxBodyBytes, onError: () => { throw tooLarge(); } }));

  // Reflecting whatever Origin arrives is effectively `*`, and it becomes a
  // full CSRF bypass the moment anyone adds a cookie session or
  // `credentials: true`. The allowlist is explicit, and `*` is refused in
  // production by the env schema.
  app.use('*', cors({
    origin: (origin, c) => {
      if (env.corsOrigins.includes('*')) return origin ?? '*';
      if (origin && env.corsOrigins.includes(origin)) return origin;
      // The beacon is posted by `sendBeacon` with a text/plain body, which is a
      // simple request — it never preflights and never reads the response, so
      // it does not need an allowed origin to work.
      return BEACON_PATHS.includes(c.req.path) ? origin ?? '' : null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'if-match'],
    exposeHeaders: ['etag', 'x-request-id'],
    maxAge: 86400,
  }));

  app.use('*', async (c, next) => { c.set('repo', repo); await next(); });

  app.onError(onError);
  // Routed through onError so an unmatched path returns problem+json like every
  // other error, rather than the plain application/json it used to.
  app.notFound(() => { throw notFound('no such route'); });

  // Public, cached at the edge.
  app.route('/', publicRoutes);
  app.route('/v1', analytics);
  app.route('/v1/auth', auth);
  app.route('/v1', me);
  app.route('/v1/handles', handles);

  // Authenticated control plane. Blocks hang off the profiles router so the
  // auth and ownership middleware runs once per request, not twice.
  app.route('/v1/profiles', profiles);

  return app;
}
