import { evaluate, type Ctx, type Block as RuleBlock } from './rules/rules.ts';
import { cacheDimensionsFor } from './publish.ts';
import { ALL_CTX_DIMS } from './auth.ts';
import type { Block, Profile } from './domain/types.ts';
import type { TVisitorContext } from './domain/schema.ts';

export type ResolvedBlock = {
  id: string;
  kind: Block['kind'];
  label: string;
  icon?: string;
  slug?: string;
  /** Where the click goes. Always the redirector, so the click is counted. */
  href: string;
  /** The destination the redirector will pick for this viewer, for previews and hints. */
  target?: string;
  items?: Block['items'];
};

export type TraceEntry = {
  blockId: string;
  ruleId: string | null;
  action: 'redirect' | 'hide';
  reason: string;
  sMaxAge: number;
};

export type Resolution = {
  handle: string;
  title: string;
  bio?: string;
  avatarUrl?: string;
  eventAt?: number | null;
  theme?: Record<string, string>;
  version: number;
  published: boolean;
  blocks: ResolvedBlock[];
  sMaxAge: number;
  cacheable: boolean;
  varyOn: string[];
  trace?: TraceEntry[];
  warnings: string[];
};

const PROFILE_TTL = 300;
const MIN_TTL = 5;

export function toRuleBlock(b: Block): RuleBlock {
  return {
    id: b.id,
    defaultTarget: b.target ?? '',
    rules: b.rules as RuleBlock['rules'],
    activeFrom: b.activeFrom,
    activeUntil: b.activeUntil,
  };
}

/**
 * The one place a profile turns into a rendered page.
 *
 * `/p/:handle`, `POST /v1/public/:handle/resolve` and the editor's preview all
 * go through here, so the page a creator previews and the page a visitor gets
 * cannot be computed by different code.
 */
export function resolveProfile(
  profile: Profile,
  all: Block[],
  // The validated body on the resolve and preview routes; the looser `Ctx` the
  // edge decoder produces on the cached paths, where the values have already
  // been normalized by `edge/normalize.js`.
  input: TVisitorContext | (Ctx & { at?: number }),
  opts: { trace?: boolean; draft?: boolean; dims?: Set<string> } = {},
): Resolution {
  // A preview supplies its own context wholesale, so every dimension is known.
  const dims = opts.dims ?? ALL_CTX_DIMS;
  const now = opts.draft && input.at ? input.at : Date.now();
  const ctx: Ctx = {
    geo: input.geo, device: input.device, referrer: input.referrer,
    lang: input.lang, webview: input.webview,
  };

  let ttl = PROFILE_TTL;
  let cacheable = true;
  const blocks: ResolvedBlock[] = [];
  const trace: TraceEntry[] = [];
  const warnings: string[] = [];

  for (const b of all) {
    if (b.hidden) continue;
    const d = evaluate(toRuleBlock(b), ctx, dims, now);

    if (!d.cacheable) {
      cacheable = false;
      if (d.reason) warnings.push(`${b.label}: ${d.reason}`);
    }
    // `d.sMaxAge` is 0 exactly on the not-cacheable branch, where it is about to
    // be discarded anyway. Writing `d.sMaxAge || PROFILE_TTL` turned that 0 into
    // 300, which was harmless only for as long as both branches stayed in step.
    if (d.cacheable) ttl = Math.min(ttl, d.sMaxAge);

    if (opts.trace) {
      trace.push({
        blockId: b.id,
        ruleId: d.ruleId,
        action: d.action.kind,
        reason: d.reason ?? (d.ruleId ? `rule ${d.ruleId} matched` : 'no rule matched, using the default'),
        sMaxAge: d.sMaxAge,
      });
    }

    if (d.action.kind === 'hide') continue;
    blocks.push({
      id: b.id,
      kind: b.kind,
      label: b.label,
      icon: b.icon,
      href: `/r/${profile.handle}/${b.id}`,
      target: d.action.target,
      items: b.items,
    });
  }

  return {
    handle: profile.handle,
    title: profile.title,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    eventAt: profile.eventAt,
    theme: profile.theme,
    version: profile.version,
    published: profile.publishedVersion !== null,
    blocks,
    sMaxAge: cacheable ? Math.max(MIN_TTL, ttl) : 0,
    cacheable,
    varyOn: cacheDimensionsFor(all),
    ...(opts.trace ? { trace } : {}),
    warnings,
  };
}
