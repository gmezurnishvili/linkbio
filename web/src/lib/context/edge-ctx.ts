import type { WireVisitorContext } from "@/lib/api/types";

/**
 * The `x-ctx` header the CloudFront viewer-request function writes.
 *
 * `v87|na.m.ig.en.0` — a version, then five fixed slots in `gdrlw` order, with
 * `-` for a dimension this profile's cache-key mask does not cover. The API
 * decodes the same header in `api/src/auth.ts`; `api/edge/normalize.js` and
 * `api/edge/page.js` are the only writers. All four have to agree slot for
 * slot, because a misread slot produces a *cacheable* wrong answer.
 *
 * Why the public page decodes it rather than re-deriving context from the raw
 * viewer headers: the cache key is built from these values, so an answer
 * computed from anything else can disagree with the key it is stored under.
 * Reading the key itself makes that impossible by construction. It also makes
 * coverage honest — a dimension the edge did not key on arrives as `-`, is sent
 * to the evaluator as unknown, and so cannot silently select a variant that the
 * next visitor with a different value would be served out of the cache.
 */

const ABSENT = "-";
const DEVICES: Record<string, NonNullable<WireVisitorContext["device"]>> = {
  m: "mobile",
  t: "tablet",
  d: "desktop",
};

export interface EdgeContext {
  /** What the evaluator should be given: only the dimensions the key covers. */
  context: WireVisitorContext;
  /** The names of those dimensions, in `gdrlw` order. */
  dims: string[];
  /**
   * The profile version the edge's mask was published for, or 0 when the header
   * carries no version. A value below the profile's current version means the
   * mask is older than the rules, so the key may not cover what the rules now
   * read.
   */
  version: number;
}

/** Null when the request did not come through the edge — local dev, or a direct origin hit. */
export function parseEdgeContext(raw: string | null | undefined): EdgeContext | null {
  if (!raw) return null;

  const bar = raw.indexOf("|");
  const version = bar < 0 ? 0 : Number(raw.slice(0, bar).replace(/^v/, "")) || 0;
  const slots = (bar < 0 ? raw : raw.slice(bar + 1)).split(".");

  const slot = (i: number): string | undefined => {
    const v = slots[i];
    return v === undefined || v === "" || v === ABSENT ? undefined : v;
  };

  const geo = slot(0);
  const device = slot(1);
  const referrer = slot(2);
  const lang = slot(3);
  const webview = slot(4);

  const context: WireVisitorContext = {
    geo: geo as WireVisitorContext["geo"],
    device: device === undefined ? undefined : DEVICES[device],
    referrer: referrer as WireVisitorContext["referrer"],
    lang,
    webview: webview === undefined ? undefined : webview === "1",
  };

  const names = ["geo", "device", "referrer", "lang", "webview"];
  const dims = names.filter((_, i) => slot(i) !== undefined);

  return { context, dims, version };
}
