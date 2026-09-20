import type { BlockRule } from "@/lib/rules/schema";

/**
 * The API contract, hand-written, in two layers.
 *
 * ── Layer 1, "wire" ──────────────────────────────────────────────────────────
 * Types prefixed `Wire` mirror `api/src/domain/types.ts`, `api/src/resolve.ts`
 * and `api/src/routes/mutation.ts` field for field. They are what actually
 * crosses the network. Nothing outside `client.ts` should need them.
 *
 * ── Layer 2, view model ──────────────────────────────────────────────────────
 * Everything else is what this app renders against, and it is deliberately not
 * the wire shape. `lib/site/render.ts` and `lib/context/visitor.ts` are owned
 * elsewhere and were written against this vocabulary, so `client.ts` translates
 * at the boundary rather than rewriting them. That translation is the honest
 * cost of the split and it is all in one place; see the adapters at the bottom
 * of `client.ts` for exactly what is invented, dropped and renamed.
 *
 * When this app lives in the same workspace as the backend, the wire half
 * should come from the server's own definitions instead:
 *
 *   import { hc } from "hono/client";
 *   import type { AppType } from "@linkctx/api";
 *
 * and the view model shrinks to whatever the renderer genuinely needs that the
 * wire does not already say.
 */

/* ══════════════════════════════════════════════════════════ layer 1: wire ══ */

/** `Profile` in api/src/domain/types.ts. Timestamps are epoch milliseconds. */
export interface WireProfile {
  id: string;
  userId: string;
  handle: string;
  title: string;
  bio?: string;
  avatarUrl?: string;
  eventAt?: number | null;
  mode?: PageMode;
  theme?: Record<string, string>;
  version: number;
  /** Null means the page has never been published, and the public routes 404. */
  publishedVersion: number | null;
  createdAt: number;
  updatedAt: number;
  /** Present on /v1/me, GET /v1/profiles and GET /v1/profiles/:id. */
  cacheDimensions?: string[];
  /** Present on GET /v1/profiles/:id only. */
  blocks?: WireBlock[];
}

/** `Block` in api/src/domain/types.ts. Rules are embedded, not referenced. */
export interface WireBlock {
  id: string;
  profileId: string;
  rank: string;
  kind: "link" | "header" | "embed" | "feed";
  label: string;
  target?: string;
  icon?: string;
  hidden: boolean;
  activeFrom?: number | null;
  activeUntil?: number | null;
  rules: BlockRule[];
  feed?: { source: string; ref: string; ttlSeconds: number };
  items?: { title: string; subtitle?: string; href?: string }[];
  feedRefreshedAt?: number;
  // The three fields that say why a feed block is empty. They have been on the
  // backend's `Block` since the refresher was written and were never carried
  // across, so the editor's feed panel could only ever say "not fetched yet" —
  // including for a ref that had been failing for a week.
  feedAttemptedAt?: number;
  feedFailures?: number;
  feedError?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * What `POST .../blocks/:id/refresh` reports about the attempt it just made.
 *
 * `unconfigured` is deliberately not a failure: it means the deployment has no
 * credential for that source, which is an operator problem and not something
 * the creator can fix by editing their ref.
 */
export type FeedOutcome =
  | { blockId: string; status: "ok"; items: number }
  | { blockId: string; status: "failed"; error: string; failures: number }
  | { blockId: string; status: "unconfigured"; error: string };

/** The body `POST /v1/profiles/:id/blocks` and `PATCH .../blocks/:bid` accept. */
export interface WireBlockInput {
  kind?: WireBlock["kind"];
  label?: string;
  target?: string;
  icon?: string;
  hidden?: boolean;
  activeFrom?: number | null;
  activeUntil?: number | null;
  rules?: BlockRule[];
  feed?: WireBlock["feed"];
  /** Create only: the id of the block to insert after. */
  after?: string;
}

/** `VisitorContext` in api/src/domain/schema.ts — normalized, coarse, enumerated. */
export interface WireVisitorContext {
  geo?: "na" | "eu" | "apac" | "latam" | "mea" | "xx";
  device?: "mobile" | "tablet" | "desktop";
  referrer?: "ig" | "tt" | "li" | "yt" | "x" | "fb" | "dir" | "oth";
  lang?: string;
  webview?: boolean;
  /** Epoch ms. Honoured on /preview only; the public path ignores it. */
  at?: number;
}

/** `TraceEntry` in api/src/resolve.ts. Only `/preview` returns these. */
export interface WireTraceEntry {
  blockId: string;
  ruleId: string | null;
  action: "redirect" | "hide";
  reason: string;
  sMaxAge: number;
}

/** `ResolvedBlock` in api/src/resolve.ts. */
export interface WireResolvedBlock {
  id: string;
  kind: WireBlock["kind"];
  label: string;
  icon?: string;
  slug?: string;
  /** Always the redirector, so the click is counted. */
  href: string;
  /** Where the redirector will send *this* viewer. */
  target?: string;
  items?: WireBlock["items"];
}

/** `Resolution` in api/src/resolve.ts. */
export interface WireResolution {
  handle: string;
  title: string;
  bio?: string;
  avatarUrl?: string;
  eventAt?: number | null;
  mode?: PageMode;
  theme?: Record<string, string>;
  version: number;
  published: boolean;
  blocks: WireResolvedBlock[];
  sMaxAge: number;
  cacheable: boolean;
  varyOn: string[];
  trace?: WireTraceEntry[];
  /** Plain sentences, not codes: "Merch: mask missing geo". */
  warnings: string[];
}

export interface WireSession {
  userId: string;
  email: string;
  profiles: WireProfile[];
}

/** `Mutation<T>` in api/src/routes/mutation.ts. Every write answers in this envelope. */
export interface Mutation<T> {
  data: T;
  version: number;
  cacheDimensions: CacheDimension[];
}

/** RFC 9457. `title` carries the code; `current` rides along on a version conflict. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: unknown;
  requestId?: string;
  current?: number;
}

/* ════════════════════════════════════════════════════ layer 2: view model ══ */

/**
 * The palette vocabulary, and only that.
 *
 * `DIMENSION_TONE` in components/ui/primitives.tsx is a `Record` over this
 * union, so it names the colours the product uses for context, not the
 * dimensions a rule can be built on — those are `RuleDimension` in
 * lib/rules/schema.ts and they come from the backend. `lib/rules/language.ts`
 * maps one onto the other.
 */
export type Dimension = "country" | "region" | "device" | "os" | "referrer" | "language" | "time";

/**
 * A cache-key dimension, as a bare string rather than a union.
 *
 * Both the authoritative mask (`cacheDimensionsFor` in api/src/publish.ts — geo,
 * device, referrer, lang, webview, time) and the estimate this app computes
 * while an edit is unsaved now speak the backend's names, but the older ones —
 * country, language, tz-bucket — still reach `varyHeader` from a profile whose
 * mask was written before that was true. Narrowing to the current vocabulary
 * would make the type lie about what arrives at runtime, so it says what is
 * true: a label.
 */
export type CacheDimension = string;

/* ---- rule advisories ----------------------------------------------------- */

/**
 * A time window as `lib/rules/dst.ts` wants it.
 *
 * That module finds the DST gaps and repeats a window falls into, and it
 * predates the backend's `{dim:"time", tz, days, from, to}`. The two carry the
 * same four facts under different names, so `toTimeWindow` in
 * lib/rules/language.ts renames rather than converts. The rest of the
 * pre-backend rule vocabulary — `Rule`, `Condition`, `Operator`, `RuleEffect` —
 * is gone: nothing authored it and nothing read it except a test that pinned it
 * in place.
 */
export interface TimeWindow {
  /** IANA zone, or "viewer" for visitor-local. The evaluator does wall-clock math in it. */
  timezone: string;
  /** 0 = Sunday. Empty means every day. */
  daysOfWeek: number[];
  /** "HH:mm" wall time. An end before start means the window crosses midnight. */
  start: string;
  end: string;
}

export interface RuleWarning {
  code: "dst-gap" | "dst-ambiguous" | "unreachable" | "shadowed" | "no-effect";
  message: string;
  /** For the DST codes: the local date the transition falls on. */
  onDate?: string;
}

/* ---- profile and blocks ------------------------------------------------- */

/**
 * The editor's block kinds, which are exactly the backend's.
 *
 * "gate" and "text" are gone: neither exists in `BLOCK_KINDS`, so a block of
 * either kind was a 400 waiting to happen. A note is now `header`.
 */
export type BlockKind = "link" | "header" | "embed" | "feed";


export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  /** Destination for kind "link" — the backend calls it `target`. */
  url?: string;
  icon?: string;
  /** Fractional index. Server-minted; only computed here for optimistic order. */
  rank: string;
  hidden: boolean;
  /** Embedded, and replaced as a whole set. There is no profile-level pool. */
  rules: BlockRule[];
  /** Epoch ms. Outside this span the block resolves to `hide`, with no rule involved. */
  activeFrom?: number | null;
  activeUntil?: number | null;
  /** kind "feed": which adapter fills it, what from, and how often. */
  feed?: { source: string; ref: string; ttlSeconds: number };
  /** Epoch ms of the last fetch that returned items. */
  feedRefreshedAt?: number;
  /** Epoch ms of the last attempt, successful or not. Drives the backoff. */
  feedAttemptedAt?: number;
  /** Consecutive failures; the refresher doubles the interval per failure. */
  feedFailures?: number;
  /** Why the last attempt failed, shown in the editor. */
  feedError?: string;
  items?: { title: string; subtitle?: string; href?: string }[];
}

export type PageMode = "standard" | "event" | "drop";

export interface Theme {
  preset: "paper" | "ink" | "signal";
  accent: string;
  typeface: "system" | "serif" | "grotesque";
  cornerStyle: "pill" | "soft" | "square";
}

export interface Profile {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl?: string;
  /**
   * A real backend field now. It used to be derived from whether `eventAt` was
   * set, which collapsed "event" and "drop" into the same wire state: the Drop
   * button sent an empty patch, and going back to Standard was inexpressible
   * because the patch adapter filtered out the null that would clear the date.
   */
  mode: PageMode;
  /** ISO instant. The wire carries epoch ms. */
  eventAt?: string;
  theme: Theme;
  blocks: Block[];
  /** Bumped by every write to the profile or its blocks. Sent as If-Match. */
  version: number;
  /** Authoritative mask, derived server-side and published to KeyValueStore. */
  cacheDimensions: CacheDimension[];
  /** Null means never published. Equal to `version` means nothing is pending. */
  publishedVersion: number | null;
}

/**
 * What the public renderer asks for.
 *
 * Richer than the wire context on purpose: this is what a request's headers
 * actually say, and `lib/context/visitor.ts` fills it from them. The client
 * coarsens it — country to a geo bucket, referrer host to a source code — the
 * same way `edge/normalize.js` does, so a page rendered here and a page served
 * from the edge are keyed on the same values.
 */
export interface VisitorContext {
  country?: string;
  /**
   * The bucket itself, for a caller that starts from one. The simulator does:
   * six buckets is all the evaluator can tell apart, and standing one of them
   * up as a country would be a fiction with no right answer — there is no
   * country that means `xx`. Where both are present the bucket wins.
   */
  geo?: WireVisitorContext["geo"];
  region?: string;
  device?: "mobile" | "tablet" | "desktop";
  os?: "ios" | "android" | "macos" | "windows" | "other";
  referrerHost?: string;
  /** The source code itself, same reason as `geo`. `dir` has no host at all. */
  referrer?: WireVisitorContext["referrer"];
  language?: string;
  /** True inside an in-app browser. */
  webview?: boolean;
  /** ISO instant. Only the draft preview honours it. */
  at: string;
}

export interface ResolvedBlock {
  id: string;
  /**
   * The same four kinds the editor has. There was a wider `RenderedBlockKind`
   * here covering `gate` and `text`, which the renderer had arms for and the
   * backend could not produce — the widened type is what let those arms sit
   * unreachable without the compiler saying so.
   */
  kind: BlockKind;
  label: string;
  /**
   * A short glyph shown before the label — one emoji, in practice. It has been
   * on the block and in the resolver's output since they were written, and the
   * renderer never printed it, so setting one did nothing at all.
   */
  icon?: string;
  href?: string;
  /**
   * Where `href` will send *this* viewer, which is a different fact from where
   * the click goes. The renderer shows it and nothing links to it: on a page
   * whose destination varies by context, the hint is the only honest way for a
   * visitor to see where an opaque redirector leads.
   */
  target?: string;
  slug?: string;
  items?: { title: string; subtitle?: string; href?: string }[];
}

export interface DecisionStep {
  ruleId: string;
  ruleName: string;
  outcome: "match" | "skip";
  /** Why, in the evaluator's own words. */
  because: string;
}

export interface Resolution {
  profile: Pick<
    Profile,
    "handle" | "displayName" | "bio" | "avatarUrl" | "mode" | "theme" | "eventAt"
  >;
  blocks: ResolvedBlock[];
  /** Seconds until the earliest instant any decision above could change. */
  sMaxAge: number;
  /** Which dimensions actually affected this resolution. */
  varyOn: CacheDimension[];
  trace: DecisionStep[];
  warnings: RuleWarning[];
  /** False while the page is still a draft. The public routes 404 in that state. */
  published: boolean;
  version: number;
}

export interface Session {
  userId: string;
  email: string;
  profiles: { id: string; handle: string; displayName: string; publishedVersion: number | null }[];
}

export interface HandleCheck {
  available: boolean;
  reason?: "taken" | "reserved" | "invalid" | "tombstoned";
}

/* ══════════════════════════════════════════════════════════════ failures ══ */

export class ApiError extends Error {
  /**
   * The problem document's `title`, which carries the code. Absent when the
   * response was not problem+json at all — a proxy 502, say.
   */
  readonly code: string | null;
  /** The server's current version, on a version conflict. */
  readonly current: number | null;

  constructor(
    readonly status: number,
    message: string,
    readonly problem?: Problem,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = problem?.title ?? null;
    this.current = typeof problem?.current === "number" ? problem.current : null;
  }

  /**
   * A stale If-Match, and nothing else.
   *
   * Keyed on the code rather than on the status because the backend answers 409
   * for two unrelated things (api/src/errors.ts): this, and a plain conflict —
   * the block limit, a handle someone else holds. Keying on 409 meant hitting
   * the block cap told the creator "this page changed somewhere else", which is
   * both false and unactionable, and locked the editor until they reloaded.
   */
  get isVersionConflict() {
    return this.code === "version_conflict";
  }

  /** A 409 that reloading will not fix: the value itself is unusable. */
  get isConflict() {
    return this.status === 409 && this.code !== "version_conflict";
  }

  get isUnauthorized() {
    return this.status === 401;
  }
}
