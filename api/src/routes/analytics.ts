import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { EventBatch } from '../domain/schema.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, forbidden, notFound, tooMany } from '../errors.ts';
import { env } from '../env.ts';
import type { Env } from '../app.ts';

export const analytics = new Hono<Env>();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A crude per-container throttle.
 *
 * Each Lambda execution environment keeps its own counter, so this bounds what
 * one container will do rather than what the fleet will accept — the real limit
 * is the WAF rate rule the stack now configures. It is here because this
 * endpoint is unauthenticated and each request can cost a burst of writes.
 */
const seen = new Map<string, { n: number; resetAt: number }>();
function throttle(key: string, limit: number) {
  const now = Date.now();
  const cur = seen.get(key);
  if (!cur || cur.resetAt <= now) {
    seen.set(key, { n: 1, resetAt: now + 60_000 });
    if (seen.size > 20_000) seen.clear();
    return;
  }
  if (++cur.n > limit) throw tooMany();
}

/** One request may not fan out across the whole namespace. */
const MAX_HANDLES_PER_BATCH = 4;

/**
 * Public click beacon. Unauthenticated by design — it is called from the
 * viewer's browser — so it is strictly append-only, capped at 50 events per
 * call, and it never echoes anything back that could be used to enumerate.
 *
 * Three things it now refuses that it used to accept: more than a handful of
 * distinct handles per request (each one is a profile lookup, so 50 handles was
 * 100 unauthenticated reads), events for blocks that do not belong to the
 * profile (attacker-chosen ids used to land in the owner's analytics and, on
 * DynamoDB, accumulate toward the item size limit), and more than
 * `EVENTS_PER_MINUTE` requests from one address.
 */
analytics.post('/events', async (c) => {
  throttle(
    c.req.header('cloudfront-viewer-address') ?? c.req.header('x-forwarded-for') ?? 'unknown',
    env.eventsPerMinute,
  );

  // The body is parsed by hand rather than with `zValidator('json', ...)`,
  // which requires an `application/json` content type and answered 400 to
  // everything the browser actually sends here. `navigator.sendBeacon` posts
  // `text/plain` precisely so the request stays "simple" and skips the
  // preflight a redirect cannot afford to wait for.
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw badRequest('body must be JSON');
  }
  const parsed = EventBatch.safeParse(body);
  if (!parsed.success) {
    throw badRequest('validation failed', parsed.error.issues.map((i) => ({
      path: i.path.join('.'), message: i.message,
    })));
  }
  const { events } = parsed.data;
  const byHandle = new Map<string, typeof events>();
  for (const e of events) {
    const list = byHandle.get(e.handle) ?? [];
    list.push(e);
    byHandle.set(e.handle, list);
  }
  if (byHandle.size > MAX_HANDLES_PER_BATCH) throw badRequest('too many handles in one batch');

  const now = Date.now();
  await Promise.all([...byHandle].map(async ([handle, list]) => {
    const p = await c.var.repo.getProfileByHandle(handle);
    if (!p) return;

    // Only ids that exist on this profile are counted. Anything else would let
    // a caller mint unbounded keys in someone else's analytics.
    const known = new Set((await c.var.repo.listBlocks(p.id)).map((b) => b.id));

    // Clamp client-supplied timestamps into the current UTC day: an attacker
    // could otherwise write into arbitrary past or future daily buckets.
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(),
    );
    const clean = list
      .filter((e) => !e.blockId || known.has(e.blockId))
      .map((e) => ({ ...e, ts: Math.min(now, Math.max(dayStart, e.ts)) }));
    if (clean.length) await c.var.repo.recordEvents(clean, p.id);
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
