import { Hono } from 'hono';
import { zValidator } from './validate.ts';
import { notFound } from '../errors.ts';
import { ALL_CTX_DIMS, ctxDims, ctxVersion, viewerCtx } from '../auth.ts';
import { cacheControl, evaluate } from '../rules/rules.ts';
import { resolveProfile, toRuleBlock } from '../resolve.ts';
import { VisitorContext } from '../domain/schema.ts';
import type { Env } from '../app.ts';

export const publicRoutes = new Hono<Env>();

/**
 * Hono's executionCtx getter throws when no platform provides one (the node
 * adapter, and `app.request` in tests), so it cannot be probed with `?.`.
 *
 * The Lambda adapter is one of the platforms that does not provide one, which
 * meant this always fell through to the catch and left the write unawaited —
 * and Lambda freezes the execution environment the moment the handler's promise
 * settles, so the click was usually dropped. Awaiting a single UpdateItem costs
 * a few milliseconds on the miss path only; losing the data costs the feature.
 */
async function background(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
  work: Promise<unknown>,
) {
  const swallowed = work.catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'click accounting failed', err: String(err) }));
  });
  try {
    c.executionCtx?.waitUntil(swallowed);
    return;
  } catch {
    await swallowed;
  }
}

/**
 * What the edge actually keyed this request on.
 *
 * Deriving the dimensions from the current database rules instead makes the
 * coverage check in `evaluate` complete by construction, so it can only ever
 * pass — which is why a mask that did not cover a rule produced a *cacheable*
 * wrong answer rather than `no-store`. With no `x-ctx` at all the request did
 * not come through the edge, so nothing is cached on our behalf and every
 * dimension is available from the raw headers.
 */
function requestContext(c: { req: { header(n: string): string | undefined } }) {
  const raw = c.req.header('x-ctx');
  return { ctx: viewerCtx((n) => c.req.header(n)), dims: ctxDims(raw) ?? ALL_CTX_DIMS };
}

/** The edge keyed this request under a mask older than the one the rules now need. */
function edgeIsStale(c: { req: { header(n: string): string | undefined } }, version: number) {
  const seen = ctxVersion(c.req.header('x-ctx'));
  return seen > 0 && seen < version;
}

publicRoutes.get('/p/:handle', async (c) => {
  const profile = await c.var.repo.getProfileByHandle(c.req.param('handle'));
  if (!profile || profile.publishedVersion === null) throw notFound('no such page');

  const all = await c.var.repo.listBlocks(profile.id);
  const { ctx, dims } = requestContext(c);
  const res = resolveProfile(profile, all, ctx, { dims });

  // `/r/` refused to let a stale key store its answer; this route did not, so a
  // payload computed under one mask was cached under a key built from an older
  // one — the exact failure the other route goes out of its way to prevent.
  const stale = edgeIsStale(c, profile.version);

  c.header('cache-control', res.cacheable && !stale ? `max-age=0, s-maxage=${res.sMaxAge}` : 'no-store');
  c.header('vary', 'x-ctx');
  return c.json(res);
});

/**
 * Resolution for a caller-supplied visitor context.
 *
 * The web app's public page calls this server-side: it needs the blocks and the
 * exact `s-maxage` in one response so the HTML and the TTL it is cached under
 * cannot disagree.
 */
publicRoutes.post('/v1/public/:handle/resolve', zValidator('json', VisitorContext), async (c) => {
  const profile = await c.var.repo.getProfileByHandle(c.req.param('handle'));
  if (!profile || profile.publishedVersion === null) throw notFound('no such page');

  const all = await c.var.repo.listBlocks(profile.id);
  const body = c.req.valid('json');
  // The caller states the context, so it is complete by definition — but only
  // the dimensions it actually supplied count as covered.
  const supplied = new Set<string>(
    (['geo', 'device', 'referrer', 'lang', 'webview'] as const).filter((k) => body[k] !== undefined),
  );
  const res = resolveProfile(profile, all, body, { dims: supplied });

  c.header('cache-control', 'no-store'); // the caller owns the caching decision
  return c.json(res);
});

/**
 * The redirect hot path on cache miss.
 *
 * Always 302 or 307, never 301: a permanent redirect would be cached by the
 * browser indefinitely and would survive every TTL this endpoint computes,
 * which for a scheduled or geo-targeted link means permanently wrong.
 */
publicRoutes.get('/r/:handle/:blockId', async (c) => {
  const profile = await c.var.repo.getProfileByHandle(c.req.param('handle'));
  if (!profile || profile.publishedVersion === null) throw notFound('no such page');

  const all = await c.var.repo.listBlocks(profile.id);
  const block = all.find((b) => b.id === c.req.param('blockId'));
  if (!block) throw notFound('no such link');

  const { ctx, dims } = requestContext(c);
  const decision = evaluate(toRuleBlock(block), ctx, dims, Date.now());
  const stale = edgeIsStale(c, profile.version);

  c.header('cache-control', decision.cacheable && !stale ? cacheControl(decision) : 'no-store');
  c.header('vary', 'x-ctx');
  c.header('x-rule-id', decision.ruleId ?? 'default');

  if (decision.action.kind === 'hide') {
    return c.json({ error: 'link is not available right now' }, 404);
  }

  const target = decision.action.target;
  if (!target) throw notFound('link has no destination');

  await background(c, c.var.repo.recordEvents([{
    handle: profile.handle, blockId: block.id, ruleId: decision.ruleId,
    ts: Date.now(), geo: ctx.geo as never, device: ctx.device as never,
    referrer: ctx.referrer as never,
  }], profile.id));

  return c.redirect(target, decision.action.status);
});

publicRoutes.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));
