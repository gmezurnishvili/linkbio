import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { EventBatch } from '../domain/schema.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import type { Env } from '../app.ts';

export const analytics = new Hono<Env>();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Public click beacon. Unauthenticated by design — it is called from the
 * viewer's browser — so it is strictly append-only, capped at 50 events per
 * call, and it never echoes anything back that could be used to enumerate.
 */
analytics.post('/events', zValidator('json', EventBatch), async (c) => {
  const { events } = c.req.valid('json');
  const byHandle = new Map<string, typeof events>();
  for (const e of events) {
    const list = byHandle.get(e.handle) ?? [];
    list.push(e);
    byHandle.set(e.handle, list);
  }
  const now = Date.now();
  await Promise.all([...byHandle].map(async ([handle, list]) => {
    const p = await c.var.repo.getProfileByHandle(handle);
    if (!p) return;
    // Clamp client-supplied timestamps into the current UTC day: an attacker
    // could otherwise write into arbitrary past or future daily buckets.
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(),
    );
    const clamped = list.map((e) => ({ ...e, ts: Math.min(now, Math.max(dayStart, e.ts)) }));
    await c.var.repo.recordEvents(clamped, p.id);
  }));
  return c.body(null, 202);
});

analytics.get('/profiles/:id/analytics', requireAuth, async (c) => {
  const p = await c.var.repo.getProfile(c.req.param('id'));
  if (!p) throw notFound('profile not found');
  if (p.userId !== c.get('auth').userId) throw forbidden();

  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10);
  const from = c.req.query('from') ??
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!DATE.test(from) || !DATE.test(to)) throw badRequest('from/to must be YYYY-MM-DD');
  if (from > to) throw badRequest('from must not be after to');

  const [daily, totals] = await Promise.all([
    c.var.repo.getDaily(p.id, from, to),
    c.var.repo.getBlockTotals(p.id),
  ]);
  return c.json({
    range: { from, to },
    totals: {
      views: daily.reduce((a, d) => a + d.views, 0),
      clicks: daily.reduce((a, d) => a + d.clicks, 0),
    },
    daily,
    byBlock: totals,
  });
});
