import {
  ApiError,
  type Block,
  type BlockKind,
  type CacheDimension,
  type DecisionStep,
  type HandleCheck,
  type Mutation,
  type Problem,
  type Profile,
  type ResolvedBlock,
  type Resolution,
  type RuleWarning,
  type Session,
  type Theme,
  type VisitorContext,
  type WireTraceEntry,
  type WireBlock,
  type WireBlockInput,
  type WireProfile,
  type WireResolution,
  type WireSession,
  type WireVisitorContext,
} from "./types";
import type { FeedOutcome } from "./types";
import type { BlockRule } from "@/lib/rules/schema";

/**
 * In the browser, every call goes to /api/proxy on our own origin. The access
 * token lives in an httpOnly cookie and is attached by the proxy, so no script
 * running on this origin can read it. That matters more here than usual: the
 * same apex domain also serves creator-authored pages.
 *
 * On the server we skip the proxy and call the backend directly.
 *
 * Below the transport sit the adapters. The backend's vocabulary and the
 * renderer's are not the same — see the header of ./types — and this is the one
 * place they meet. Everything the translation invents, drops or renames is
 * commented where it happens; nothing about it is silent.
 */
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api/proxy";

export interface CallOptions {
  /** Server-side only: bearer token to attach. */
  token?: string;
  /** Sent as If-Match. Omitting it tells the backend not to check. */
  version?: number;
  signal?: AbortSignal;
  /** Server-side only. Defaults to no-store; the public renderer overrides it. */
  cache?: RequestCache;
}

function base() {
  if (typeof window !== "undefined") return BROWSER_BASE;
  const origin = process.env.API_ORIGIN;
  if (!origin) throw new Error("API_ORIGIN is not set");
  return origin;
}

/**
 * One round trip. Returns the parsed body, or `undefined` for a 204 — and the
 * two callers below are what decide whether that is allowed.
 *
 * Errors are RFC 9457 problem+json (api/src/errors.ts). `detail` is the human
 * sentence and `title` is the code; the proxy answers with `{message}` instead
 * when it refuses a request before it ever reaches the backend, so both are
 * read.
 */
async function request(
  method: string,
  path: string,
  body: unknown,
  opts: CallOptions,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.version !== undefined) headers["if-match"] = String(opts.version);

  const res = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
    cache: opts.cache ?? "no-store",
    credentials: typeof window === "undefined" ? "omit" : "same-origin",
  });

  const text = res.status === 204 ? "" : await res.text();
  const payload = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const problem = (payload ?? {}) as Problem & { message?: string };
    throw new ApiError(res.status, problem.detail ?? problem.message ?? res.statusText, problem);
  }
  return payload;
}

/**
 * A call that must answer with a body.
 *
 * The 204 case used to be `return undefined as T`, which handed every caller a
 * value that lied about its own type. The store then read a falsy result as
 * failure and rolled the UI back over a *successful* DELETE. Success and
 * failure are now carried out of band — `guard` in the profile store returns a
 * tagged result — and an empty body where one was expected is a real error
 * rather than a `T` that happens to be undefined.
 */
async function call<T>(method: string, path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
  const payload = await request(method, path, body, opts);
  if (payload === undefined) {
    throw new ApiError(204, `${method} ${path} answered with no body, but one was expected`);
  }
  return payload as T;
}

/** A call whose success is the status code. DELETE answers 204 with nothing in it. */
async function callEmpty(method: string, path: string, body: unknown, opts: CallOptions = {}): Promise<void> {
  await request(method, path, body, opts);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

const id = (value: string) => encodeURIComponent(value);

export const api = {
  /* ---- session ---------------------------------------------------------- */

  session: async (o?: CallOptions): Promise<Session> => {
    const wire = await call<WireSession>("GET", "/v1/me", undefined, o);
    return {
      userId: wire.userId,
      email: wire.email,
      profiles: wire.profiles.map((p) => ({
        id: p.id,
        handle: p.handle,
        displayName: p.title,
        publishedVersion: p.publishedVersion,
      })),
    };
  },

  /* ---- profile ---------------------------------------------------------- */

  /**
   * Creates the profile and claims the handle in one transaction. Two calls
   * would leave a profile with no handle if the second one lost a race.
   *
   * A handle someone else holds comes back as 409 `conflict`, not
   * `version_conflict` — there is nothing to reload, the value is just taken.
   */
  createProfile: async (
    input: { handle: string; displayName: string },
    o?: CallOptions,
  ): Promise<Profile> => {
    const res = await call<Mutation<WireProfile>>(
      "POST",
      "/v1/profiles",
      { handle: input.handle, title: input.displayName },
      o,
    );
    return toProfile(res.data, [], res.cacheDimensions);
  },

  profile: async (profileId: string, o?: CallOptions): Promise<Profile> => {
    const wire = await call<WireProfile>("GET", `/v1/profiles/${id(profileId)}`, undefined, o);
    return toProfile(wire, wire.blocks ?? [], wire.cacheDimensions ?? []);
  },

  updateProfile: (
    profileId: string,
    patch: Partial<Pick<Profile, "displayName" | "bio" | "avatarUrl" | "mode" | "eventAt">> & {
      theme?: Partial<Theme>;
    },
    o?: CallOptions,
  ) =>
    call<Mutation<WireProfile>>("PATCH", `/v1/profiles/${id(profileId)}`, toProfilePatch(patch), o),

  /**
   * Makes the current draft live. Until this lands `publishedVersion` is null
   * and `/p/:handle` 404s for everyone, so the button is not decoration.
   */
  publish: (profileId: string, o?: CallOptions) =>
    call<Mutation<WireProfile>>("POST", `/v1/profiles/${id(profileId)}/publish`, {}, o),

  /**
   * Takes the page down and keeps the draft. The public routes 404 again, which
   * is the same state the page was in before its first publish — so publishing
   * later puts back exactly what was there.
   */
  unpublish: (profileId: string, o?: CallOptions) =>
    call<Mutation<WireProfile>>("POST", `/v1/profiles/${id(profileId)}/unpublish`, {}, o),

  /**
   * Deletes the page and everything on it.
   *
   * The backend retracts the edge routing before it drops the rows, which is
   * the ordering that matters: a hot link left in the KeyValueStore would keep
   * redirecting visitors to a deleted page's destination long after the page
   * itself stopped existing. Nothing here has to know that — it is noted
   * because the reverse order would look identical from this side.
   *
   * 204, no body, no undo.
   */
  deleteProfile: (profileId: string, o?: CallOptions) =>
    callEmpty("DELETE", `/v1/profiles/${id(profileId)}`, undefined, o),

  /** Unauthenticated, and a property of the namespace rather than of a profile. */
  checkHandle: (handle: string, o?: CallOptions) =>
    call<HandleCheck>("GET", `/v1/handles/${id(handle)}`, undefined, o),

  /** Transactional server-side, with 90-day tombstoning of the handle given up. */
  claimHandle: (profileId: string, handle: string, o?: CallOptions) =>
    call<Mutation<WireProfile>>("POST", `/v1/profiles/${id(profileId)}/handle`, { handle }, o),

  /* ---- blocks ----------------------------------------------------------- */

  createBlock: (
    profileId: string,
    input: Pick<Block, "kind" | "label"> & Partial<Block>,
    o?: CallOptions,
  ) =>
    call<Mutation<WireBlock>>(
      "POST",
      `/v1/profiles/${id(profileId)}/blocks`,
      toBlockInput(input),
      o,
    ),

  updateBlock: (profileId: string, blockId: string, patch: Partial<Block>, o?: CallOptions) =>
    call<Mutation<WireBlock>>(
      "PATCH",
      `/v1/profiles/${id(profileId)}/blocks/${id(blockId)}`,
      toBlockInput(patch),
      o,
    ),

  /** 204, with nothing in the body. The caller's success signal is the absence of a throw. */
  deleteBlock: (profileId: string, blockId: string, o?: CallOptions) =>
    callEmpty("DELETE", `/v1/profiles/${id(profileId)}/blocks/${id(blockId)}`, undefined, o),

  /**
   * Reorder by neighbour, not by key. The server mints the fractional index,
   * which keeps key generation in one place and lets it rebalance when the
   * gap between two neighbours gets too small to split.
   */
  moveBlock: (
    profileId: string,
    blockId: string,
    neighbours: { afterId: string | null; beforeId: string | null },
    o?: CallOptions,
  ) =>
    call<Mutation<WireBlock>>(
      "POST",
      `/v1/profiles/${id(profileId)}/blocks/${id(blockId)}/move`,
      // Absent, not null: `MoveBlock` wants one of the two and a null would
      // fail its "provide beforeId or afterId" refinement with both set.
      {
        ...(neighbours.afterId ? { afterId: neighbours.afterId } : {}),
        ...(!neighbours.afterId && neighbours.beforeId ? { beforeId: neighbours.beforeId } : {}),
      },
      o,
    ),

  /**
   * Fetch this block's feed now, instead of waiting for the scheduler.
   *
   * The refresher runs one TTL apart, so a newly added feed block is empty for
   * up to an hour and a wrong channel id is indistinguishable from a slow one.
   * The outcome comes back with the block: `unconfigured` is an operator
   * problem (a missing credential), `failed` carries the message the adapter
   * threw, and both are answers rather than errors.
   */
  refreshFeed: (profileId: string, blockId: string, o?: CallOptions) =>
    call<Mutation<WireBlock> & { outcome: FeedOutcome }>(
      "POST",
      `/v1/profiles/${id(profileId)}/blocks/${id(blockId)}/refresh`,
      {},
      o,
    ),

  /* ---- rules ------------------------------------------------------------ */

  /**
   * The whole rule set for one block, replaced.
   *
   * There is no per-rule endpoint and no profile-level pool — a rule belongs to
   * the block it routes, and the body here is the complete array. Sending a
   * subset deletes the rest, which is the point: the client never has to
   * reason about a partially-applied set.
   */
  saveBlockRules: (profileId: string, blockId: string, rules: BlockRule[], o?: CallOptions) =>
    call<Mutation<WireBlock>>(
      "PUT",
      `/v1/profiles/${id(profileId)}/blocks/${id(blockId)}/rules`,
      rules,
      o,
    ),

  /* ---- resolution ------------------------------------------------------- */

  /**
   * Public read path. Runs the same evaluator the edge function runs and
   * returns sMaxAge alongside the page, so the renderer can set an exact TTL.
   * 404s for a profile that has never been published.
   */
  resolve: async (handle: string, ctx: VisitorContext, o?: CallOptions): Promise<Resolution> =>
    toResolution(
      await call<WireResolution>("POST", `/v1/public/${id(handle)}/resolve`, toWireContext(ctx), o),
    ),

  /**
   * Authenticated preview. Same evaluator, an injected context, and the draft
   * rather than the published version. Returns the decision trace, and honours
   * the instant in `ctx.at` so the simulator can travel in time.
   */
  preview: async (profileId: string, ctx: VisitorContext, o?: CallOptions): Promise<Resolution> =>
    toResolution(
      await call<WireResolution>("POST", `/v1/profiles/${id(profileId)}/preview`, toWireContext(ctx), o),
    ),
};

/* ═══════════════════════════════════════════════════════════ wire → view ══ */

export function toProfile(
  wire: WireProfile,
  blocks: WireBlock[],
  cacheDimensions: CacheDimension[],
): Profile {
  return {
    id: wire.id,
    handle: wire.handle,
    displayName: wire.title,
    bio: wire.bio ?? "",
    avatarUrl: wire.avatarUrl,
    // Stored on the profile. The fallback is for rows written before the
    // column existed: an instant on the page meant "event" by definition then,
    // and reading them as standard would silently hide a live countdown.
    mode: wire.mode ?? (wire.eventAt ? "event" : "standard"),
    eventAt: wire.eventAt ? new Date(wire.eventAt).toISOString() : undefined,
    theme: toTheme(wire.theme),
    blocks: blocks.map(toBlock),
    version: wire.version,
    cacheDimensions,
    publishedVersion: wire.publishedVersion,
  };
}

export function toBlock(wire: WireBlock): Block {
  return {
    id: wire.id,
    kind: wire.kind,
    label: wire.label,
    url: wire.target,
    icon: wire.icon,
    rank: wire.rank,
    hidden: wire.hidden,
    rules: wire.rules ?? [],
    activeFrom: wire.activeFrom,
    activeUntil: wire.activeUntil,
    feed: wire.feed,
    feedRefreshedAt: wire.feedRefreshedAt,
    feedAttemptedAt: wire.feedAttemptedAt,
    feedFailures: wire.feedFailures,
    feedError: wire.feedError,
    items: wire.items,
  };
}

/**
 * The theme is a free-form `Record<string, string>` on the wire, capped at 40
 * keys. The form only knows four of them, so unknown keys survive a round trip
 * untouched rather than being dropped by the editor that cannot render them.
 */
const THEME_DEFAULTS: Theme = {
  preset: "paper",
  accent: "#1b4fd8",
  typeface: "grotesque",
  cornerStyle: "soft",
};

function toTheme(raw: Record<string, string> | undefined): Theme {
  const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    ...THEME_DEFAULTS,
    ...raw,
    preset: oneOf(raw?.preset, ["paper", "ink", "signal"] as const, THEME_DEFAULTS.preset),
    accent: raw?.accent || THEME_DEFAULTS.accent,
    typeface: oneOf(raw?.typeface, ["system", "serif", "grotesque"] as const, THEME_DEFAULTS.typeface),
    cornerStyle: oneOf(raw?.cornerStyle, ["pill", "soft", "square"] as const, THEME_DEFAULTS.cornerStyle),
  };
}

export function toResolution(wire: WireResolution): Resolution {
  const blocks: ResolvedBlock[] = wire.blocks.map((b) => ({
    id: b.id,
    // No translation any more. This used to map `header` to `text`, because
    // `text` was the only arm the renderer had that produced something other
    // than a link card — a workaround for the missing `header` arm, and the
    // reason the renderer's kinds had drifted from the backend's in the first
    // place. The two vocabularies are the same set now.
    kind: b.kind,
    label: b.label,
    icon: b.icon,
    // The redirector, not the destination: the click has to be counted, and on
    // a page whose target varies by viewer the destination is not a property of
    // the link anyway.
    href: b.href,
    // The destination the evaluator picked for this context. It is what the
    // renderer's hint reads; deriving one from `href` is not possible, because
    // `/r/:handle/:id` says nothing about where it lands.
    target: b.target,
    slug: b.slug,
    items: b.items,
  }));

  return {
    profile: {
      handle: wire.handle,
      displayName: wire.title,
      bio: wire.bio ?? "",
      avatarUrl: wire.avatarUrl,
      mode: wire.mode ?? (wire.eventAt ? "event" : "standard"),
      eventAt: wire.eventAt ? new Date(wire.eventAt).toISOString() : undefined,
      theme: toTheme(wire.theme),
    },
    blocks,
    sMaxAge: wire.sMaxAge,
    varyOn: wire.varyOn,
    trace: (wire.trace ?? []).map((t) => toDecisionStep(t, blocks)),
    // The backend's warnings are whole sentences about a block, not coded
    // findings about a rule: "Merch: mask missing geo". There is no code that
    // fits, and inventing a specific one would drive the wrong colour in the
    // builder, so they all arrive as the generic one.
    warnings: wire.warnings.map((message): RuleWarning => ({ code: "no-effect", message })),
    published: wire.published,
    version: wire.version,
  };
}

/**
 * A trace entry as the simulator reads it.
 *
 * Rules have no name on the backend — `Rule` is `{id, priority, when, then}` —
 * so the row is labelled with the block it decided, which is the thing a
 * creator is actually looking for in a list of decisions.
 */
function toDecisionStep(t: WireTraceEntry, blocks: ResolvedBlock[]): DecisionStep {
  const block = blocks.find((b) => b.id === t.blockId);
  return {
    ruleId: t.ruleId ?? `${t.blockId}:default`,
    ruleName: block?.label ?? t.blockId,
    outcome: t.ruleId ? "match" : "skip",
    because: t.reason,
  };
}

/* ═══════════════════════════════════════════════════════════ view → wire ══ */

function toProfilePatch(
  patch: Partial<Pick<Profile, "displayName" | "bio" | "avatarUrl" | "mode" | "eventAt">> & {
    theme?: Partial<Theme>;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.displayName !== undefined) out.title = patch.displayName;
  if (patch.bio !== undefined) out.bio = patch.bio;
  if (patch.avatarUrl !== undefined) out.avatarUrl = patch.avatarUrl;
  if (patch.mode !== undefined) {
    out.mode = patch.mode;
    // Going back to Standard has to clear the date, or the page keeps a
    // countdown the creator can no longer see a control for. `ProfilePatch`
    // takes `eventAt` as nullable precisely so this is expressible: omitting a
    // key means "leave it alone", and only an explicit null means "remove it".
    if (patch.mode === "standard") out.eventAt = null;
  }
  if (patch.eventAt !== undefined) {
    const ms = Date.parse(patch.eventAt);
    if (Number.isFinite(ms) && ms > 0) out.eventAt = ms;
  }
  if (patch.theme) out.theme = { ...patch.theme };
  return out;
}

function toBlockInput(patch: Partial<Block>): WireBlockInput {
  const out: WireBlockInput = {};
  if (patch.kind !== undefined) out.kind = patch.kind;
  if (patch.label !== undefined) out.label = patch.label;
  if (patch.url !== undefined) out.target = patch.url;
  if (patch.icon !== undefined) out.icon = patch.icon;
  if (patch.hidden !== undefined) out.hidden = patch.hidden;
  if (patch.activeFrom !== undefined) out.activeFrom = patch.activeFrom;
  if (patch.activeUntil !== undefined) out.activeUntil = patch.activeUntil;
  if (patch.feed !== undefined) out.feed = patch.feed;
  // Rules go through PUT .../rules, which is the only endpoint that validates
  // the set as a whole. Letting them ride along on a PATCH would make "replace
  // the set" and "merge into the block" the same call with different rules.
  return out;
}

/**
 * Country to geo bucket, and referrer host to source code.
 *
 * Both tables are ports of `edge/normalize.js`, which is what computes these
 * for a cached request. The page rendered here has to be keyed on the same
 * values the edge would have used, or the two disagree about which variant a
 * visitor is in and the cache serves one of them the other's page.
 */
const GEO: Record<string, WireVisitorContext["geo"]> = {
  US: "na", CA: "na",
  MX: "latam", BR: "latam", AR: "latam", CL: "latam", CO: "latam",
  GB: "eu", IE: "eu", DE: "eu", FR: "eu", ES: "eu", IT: "eu", NL: "eu", PL: "eu", SE: "eu",
  JP: "apac", KR: "apac", CN: "apac", IN: "apac", AU: "apac", NZ: "apac", SG: "apac", ID: "apac",
  AE: "mea", SA: "mea", ZA: "mea", NG: "mea", EG: "mea", IL: "mea", TR: "mea",
};

export function geoBucket(country: string | undefined): WireVisitorContext["geo"] {
  if (!country) return undefined;
  return GEO[country.toUpperCase()] ?? "xx";
}

export function referrerCode(host: string | undefined): WireVisitorContext["referrer"] {
  if (host === undefined) return undefined;
  const h = host.toLowerCase();
  if (!h) return "dir";
  if (h.includes("instagram")) return "ig";
  if (h.includes("tiktok")) return "tt";
  if (h.includes("linkedin") || h === "lnkd.in") return "li";
  if (h.includes("youtube") || h === "youtu.be") return "yt";
  if (h.includes("twitter") || h === "t.co" || h.includes("x.com")) return "x";
  if (h.includes("facebook") || h === "fb.me") return "fb";
  return "oth";
}

/**
 * Everything the request knows, coarsened to what the cache key can carry.
 *
 * `region` and `os` have nowhere to go: the mask has five slots (gdrlw) and
 * neither is one of them. Dropping them here rather than pretending is the
 * whole reason the rule builder no longer offers them.
 */
export function toWireContext(ctx: VisitorContext): WireVisitorContext {
  const at = Date.parse(ctx.at);
  return {
    // A caller holding the coarse value already has the answer these tables
    // compute, so it wins: the public renderer starts from a country header,
    // the simulator starts from a bucket.
    geo: ctx.geo ?? geoBucket(ctx.country),
    device: ctx.device,
    referrer: ctx.referrer ?? referrerCode(ctx.referrerHost),
    lang: ctx.language ? ctx.language.slice(0, 2).toLowerCase() : undefined,
    webview: ctx.webview,
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}
