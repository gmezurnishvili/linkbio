import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requestId } from 'hono/request-id';
import { onError } from './errors.ts';
import { profiles } from './routes/profiles.ts';
import { blocks } from './routes/blocks.ts';
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

export function createApp(repo: Repo) {
  const app = new Hono<Env>();

  app.use('*', requestId());
  app.use('*', logger());
  app.use('*', secureHeaders());
  app.use('*', cors({
    origin: (o) => o ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    maxAge: 86400,
  }));
  app.use('*', async (c, next) => { c.set('repo', repo); await next(); });

  app.onError(onError);
  app.notFound((c) => c.json({ title: 'not_found', status: 404 }, 404));

  // Public, cached at the edge.
  app.route('/', publicRoutes);
  app.route('/v1', analytics);

  // Authenticated control plane.
  app.route('/v1/profiles', profiles);
  app.route('/v1/profiles/:id/blocks', blocks);

  return app;
}
