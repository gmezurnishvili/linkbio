/**
 * The API contract, hand-written.
 *
 * When this app lives in the same workspace as the backend, delete the request
 * and response shapes below and replace the client with Hono's RPC client:
 *
 *   import { hc } from "hono/client";
 *   import type { AppType } from "@linkctx/api";
 *   export const api = hc<AppType>(process.env.NEXT_PUBLIC_API_BASE!);
 *
 * Route shapes then come from the server's own definitions and the two can no
 * longer drift. The domain types below are still worth keeping, because the
 * rule builder renders against them.
 */

export type Dimension =
  | "country"
  | "region"
  | "device"
  | "os"
  | "referrer"
  | "language"
  | "time";

/** Dimensions that, once used by a live rule, must enter the CloudFront cache key. */
export const CACHE_DIMENSIONS = [
  "country",
  "region",
  "device",
  "os",
  "referrer",
  "language",
  "tz-bucket",
] as const;
export type CacheDimension = (typeof CACHE_DIMENSIONS)[number];

export type Operator = "in" | "not-in" | "equals" | "matches" | "within";

export interface Condition {
  dimension: Dimension;
  op: Operator;
  /** country/region/device/os/language: ISO codes or enum members. referrer: host globs. */
  values?: string[];
  /** Only for dimension "time". */
  window?: TimeWindow;
}

export interface TimeWindow {
  /** IANA zone. The evaluator does all wall-clock math in this zone. */
  timezone: string;
  /** 0 = Sunday. Empty means every day. */
  daysOfWeek: number[];
  /** "HH:mm" wall time. An end before start means the window crosses midnight. */
  start: string;
  end: string;
}

export type BlockKind = "link" | "feed" | "gate" | "text" | "embed";

export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  /** Destination for kind "link". Visitors reach it via /:handle/l/:slug. */
  url?: string;
  slug?: string;
  /** Rules that gate or rewrite this block. */
  ruleIds: string[];
  /** Fractional index. Server-minted; only computed here for optimistic order. */
  rank: string;
  hidden: boolean;
  /** kind "feed": which adapter fills it, and when it last succeeded. */
  source?: { adapter: string; refreshedAt?: string; itemCount?: number };
  /** kind "gate": what the visitor has to do first. */
  gate?: { type: "email" | "code" | "referrer"; prompt: string };
  /** Position is managed by the bandit rather than by rank. */
  banditEnabled: boolean;
  banditPinned: boolean;
}

export type RuleEffect =
  | { type: "show" }
  | { type: "hide" }
  | { type: "rewrite"; url: string }
  | { type: "promote"; toIndex: number };

export interface Rule {
  id: string;
  name: string;
  /** Every condition must hold. Use separate rules for or-logic. */
  conditions: Condition[];
  effect: RuleEffect;
  /** Lower runs first; ties broken by id so ordering is deterministic. */
  priority: number;
  enabled: boolean;
  /** Set by the evaluator, not by the author. */
  warnings?: RuleWarning[];
}

export interface RuleWarning {
  code: "dst-gap" | "dst-ambiguous" | "unreachable" | "shadowed" | "no-effect";
  message: string;
  /** For the DST codes: the local date the transition falls on. */
  onDate?: string;
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
  mode: PageMode;
  /** Only meaningful for mode "event" or "drop". */
  eventAt?: string;
  theme: Theme;
  blocks: Block[];
  rules: Rule[];
  /** Bumped by every block or rule mutation. Sent as If-Match on writes. */
  version: number;
  /** Authoritative mask, derived server-side and published to KeyValueStore. */
  cacheDimensions: CacheDimension[];
  publishedVersion: number | null;
  publishedAt?: string;
}

/** What the public renderer asks for, and what it gets back. */
export interface VisitorContext {
  country?: string;
  region?: string;
  device?: "mobile" | "tablet" | "desktop";
  os?: "ios" | "android" | "macos" | "windows" | "other";
  referrerHost?: string;
  language?: string;
  /** ISO instant. The evaluator converts it into each rule's own timezone. */
  at: string;
}

export interface ResolvedBlock {
  id: string;
  kind: BlockKind;
  label: string;
  href?: string;
  slug?: string;
  gate?: Block["gate"];
  items?: { title: string; subtitle?: string; href?: string }[];
}

export interface DecisionStep {
  ruleId: string;
  ruleName: string;
  outcome: "match" | "skip";
  /** Why, in the evaluator's own words: "country not in [US, CA]". */
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
}

export interface Session {
  userId: string;
  email: string;
  profiles: { id: string; handle: string; displayName: string }[];
}

export interface MoveResult {
  blockId: string;
  rank: string;
  version: number;
}

/** Every write returns the new version and mask so the client cannot go stale. */
export interface Mutation<T> {
  data: T;
  version: number;
  cacheDimensions: CacheDimension[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isVersionConflict() {
    return this.status === 409;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
}
