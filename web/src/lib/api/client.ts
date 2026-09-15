import {
  ApiError,
  type Block,
  type MoveResult,
  type Mutation,
  type Profile,
  type Resolution,
  type Rule,
  type Session,
  type Theme,
  type VisitorContext,
} from "./types";

/**
 * In the browser, every call goes to /api/proxy on our own origin. The access
 * token lives in an httpOnly cookie and is attached by the proxy, so no script
 * running on this origin can read it. That matters more here than usual: the
 * same apex domain also serves creator-authored pages.
 *
 * On the server we skip the proxy and call the backend directly.
 */
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api/proxy";

export interface CallOptions {
  /** Server-side only: bearer token to attach. */
  token?: string;
  /** Sent as If-Match. Any write that omits it will be rejected by the backend. */
  version?: number;
  signal?: AbortSignal;
  /** Server-side only. Defaults to no-store; the public renderer overrides it. */
  cache?: RequestCache;
}

function base(opts: CallOptions) {
  if (typeof window !== "undefined") return BROWSER_BASE;
  const origin = process.env.API_ORIGIN;
  if (!origin) throw new Error("API_ORIGIN is not set");
  return origin;
}

async function call<T>(
  method: string,
  path: string,
  body: unknown,
  opts: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.version !== undefined) headers["if-match"] = String(opts.version);

  const res = await fetch(`${base(opts)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
    cache: opts.cache ?? "no-store",
    credentials: typeof window === "undefined" ? "omit" : "same-origin",
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const message =
      (payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : null) ?? res.statusText;
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const api = {
  /* ---- session ---------------------------------------------------------- */

  session: (o?: CallOptions) => call<Session>("GET", "/v1/me", undefined, o),

  /* ---- profile ---------------------------------------------------------- */

  /**
   * Creates the profile and claims the handle in one transaction. Two calls
   * would leave a profile with no handle if the second one lost a race.
   */
  createProfile: (input: { handle: string; displayName: string }, o?: CallOptions) =>
    call<Profile>("POST", "/v1/profiles", input, o),

  profile: (id: string, o?: CallOptions) =>
    call<Profile>("GET", `/v1/profiles/${id}`, undefined, o),

  updateProfile: (
    id: string,
    patch: Partial<
      Pick<Profile, "displayName" | "bio" | "avatarUrl" | "mode" | "eventAt"> & {
        theme: Partial<Theme>;
      }
    >,
    o?: CallOptions,
  ) => call<Mutation<Profile>>("PATCH", `/v1/profiles/${id}`, patch, o),

  publish: (id: string, o?: CallOptions) =>
    call<Mutation<Profile>>("POST", `/v1/profiles/${id}/publish`, {}, o),

  /** Handle claiming is transactional server-side, with 90-day tombstoning. */
  checkHandle: (handle: string, o?: CallOptions) =>
    call<{ available: boolean; reason?: "taken" | "reserved" | "tombstoned" }>(
      "GET",
      `/v1/handles/${encodeURIComponent(handle)}`,
      undefined,
      o,
    ),

  claimHandle: (profileId: string, handle: string, o?: CallOptions) =>
    call<Mutation<Profile>>("POST", `/v1/profiles/${profileId}/handle`, { handle }, o),

  /* ---- blocks ----------------------------------------------------------- */

  createBlock: (
    profileId: string,
    input: Pick<Block, "kind" | "label"> & Partial<Block>,
    o?: CallOptions,
  ) => call<Mutation<Block>>("POST", `/v1/profiles/${profileId}/blocks`, input, o),

  updateBlock: (profileId: string, blockId: string, patch: Partial<Block>, o?: CallOptions) =>
    call<Mutation<Block>>("PATCH", `/v1/profiles/${profileId}/blocks/${blockId}`, patch, o),

  deleteBlock: (profileId: string, blockId: string, o?: CallOptions) =>
    call<Mutation<{ id: string }>>(
      "DELETE",
      `/v1/profiles/${profileId}/blocks/${blockId}`,
      undefined,
      o,
    ),

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
    call<MoveResult>(
      "POST",
      `/v1/profiles/${profileId}/blocks/${blockId}/move`,
      neighbours,
      o,
    ),

  /* ---- rules ------------------------------------------------------------ */

  createRule: (profileId: string, input: Omit<Rule, "id" | "warnings">, o?: CallOptions) =>
    call<Mutation<Rule>>("POST", `/v1/profiles/${profileId}/rules`, input, o),

  updateRule: (profileId: string, ruleId: string, patch: Partial<Rule>, o?: CallOptions) =>
    call<Mutation<Rule>>("PATCH", `/v1/profiles/${profileId}/rules/${ruleId}`, patch, o),

  deleteRule: (profileId: string, ruleId: string, o?: CallOptions) =>
    call<Mutation<{ id: string }>>(
      "DELETE",
      `/v1/profiles/${profileId}/rules/${ruleId}`,
      undefined,
      o,
    ),

  /* ---- resolution ------------------------------------------------------- */

  /**
   * Public read path. Runs the same evaluator the edge function runs and
   * returns sMaxAge alongside the page, so the renderer can set an exact TTL.
   */
  resolve: (handle: string, ctx: VisitorContext, o?: CallOptions) =>
    call<Resolution>("POST", `/v1/public/${encodeURIComponent(handle)}/resolve`, ctx, o),

  /**
   * Authenticated preview. Same evaluator, an injected context, and the draft
   * version rather than the published one. Returns the decision trace.
   */
  preview: (profileId: string, ctx: VisitorContext, o?: CallOptions) =>
    call<Resolution>("POST", `/v1/profiles/${profileId}/preview`, ctx, o),
};
