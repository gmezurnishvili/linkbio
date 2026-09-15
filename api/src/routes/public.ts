import { Hono } from 'hono';
import { notFound } from '../errors.ts';
import { ctxVersion, viewerCtx } from '../auth.ts';
import { deriveMask, maskDims } from '../publish.ts';
import { cacheControl, evaluate } from '../rules/rules.ts';
import type { Block as RuleBlock } from '../rules/rules.ts';
import type { Block } from '../domain/types.ts';
import type { Env } from '../app.ts';

export const publicRoutes = new Hono<Env>();

const PROFILE_TTL = 300;

/**
 * Hono's executionCtx getter throws when no platform provides one (the node
 * adapter, and `app.request` in tests), so it cannot be probed with `?.`.
 */
function background(c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>) {
  const swallowed = work.catch(() => {});
  try {
    c.executionCtx?.waitUntil(swallowed);
  } catch {
    void swallowed;
  }
}

function toRuleBlock(b: Block): RuleBlock {
  return {
    id: b.id,
    defaultTarget: b.target ?? '',
    rules: b.rules as RuleBlock['rules'],
    activeFrom: b.activeFrom,
    activeUntil: b.activeUntil,
  };
}

/**
 * Render payload for a profile page. Hidden and expired blocks are filtered
 * server-side so they never reach the client; the shortest rule boundary across
 * all visible blocks caps the page's own TTL.
 */
publicRoutes.get('/p/:handle', async (c) => {
  const profile = await c.var.repo.getProfileByHandle(c.req.param('handle'));
  if (!profile) throw notFound('no such page');

  const all = await c.var.repo.listBlocks(profile.id);
  const mask = deriveMask(all);
  const dims = maskDims(mask);
  const ctx = viewerCtx((n) => c.req.header(n));
  const now = Date.now();

  let ttl = PROFILE_TTL;
  let cacheable = true;
  const visible: unknown[] = [];

  for (const b of all) {
    if (b.hidden) continue;
    const d = evaluate(toRuleBlock(b), ctx, dims, now);
    if (!d.cacheable) cacheable = false;
    ttl = Math.min(ttl, d.sMaxAge || PROFILE_TTL);
    if (d.action.kind === 'hide') continue;
    visible.push({
      id: b.id,
      kind: b.kind,
      label: b.label,
      icon: b.icon,
      href: `/r/${profile.handle}/${b.id}`,
      target: d.action.target,
    });
  }

  c.header('cache-control', cacheable ? `max-age=0, s-maxage=${Math.max(5, ttl)}` : 'no-store');
  c.header('vary', 'x-ctx');
  return c.json({
    handle: profile.handle,
    title: profile.title,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    theme: profile.theme,
    version: profile.version,
    blocks: visible,
  });
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
  if (!profile) throw notFound('no such page');

  const all = await c.var.repo.listBlocks(profile.id);
  const block = all.find((b) => b.id === c.req.param('blockId'));
  if (!block) throw notFound('no such link');

  const mask = deriveMask(all);
  const dims = maskDims(mask);
  const ctx = viewerCtx((n) => c.req.header(n));
  const decision = evaluate(toRuleBlock(block), ctx, dims, Date.now());

  // The edge computed its cache key from an older mask than the one these
  // rules now require. The answer below is correct for this viewer but must
  // not be stored, or it will be replayed to viewers it does not describe.
  const edgeVersion = ctxVersion(c.req.header('x-ctx'));
  const stale = edgeVersion > 0 && edgeVersion < profile.version;

  c.header('cache-control', decision.cacheable && !stale ? cacheControl(decision) : 'no-store');
  c.header('vary', 'x-ctx');
  c.header('x-rule-id', decision.ruleId ?? 'default');

  if (decision.action.kind === 'hide') {
    return c.json({ error: 'link is not available right now' }, 404);
  }

  const target = decision.action.target;
  if (!target) throw notFound('link has no destination');

  // Fire-and-forget click accounting. A failure here must never cost the
  // viewer their redirect.
  background(c, c.var.repo.recordEvents([{
    handle: profile.handle, blockId: block.id, ruleId: decision.ruleId,
    ts: Date.now(), geo: ctx.geo as never, device: ctx.device as never,
    referrer: ctx.referrer as never,
  }], profile.id));

  return c.redirect(target, decision.action.status);
});

publicRoutes.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));
