import type { VisitorContext } from "@/lib/api/types";

/**
 * Visitor context is read from request headers and nothing else.
 *
 * Doing any of this in the browser would be wrong twice over: the page would
 * flash the wrong variant before correcting itself, and the HTML cached at the
 * edge would no longer match the cache key it was stored under. Every value
 * here has to come from a header CloudFront also includes in that key.
 */

/** CloudFront's viewer headers, plus the fallbacks other proxies set. */
const COUNTRY = ["cloudfront-viewer-country", "x-vercel-ip-country", "x-country-code"];
const REGION = ["cloudfront-viewer-country-region", "x-vercel-ip-country-region"];

export function visitorContextFromHeaders(h: Headers, now = new Date()): VisitorContext {
  const ua = h.get("user-agent") ?? "";
  return {
    country: firstOf(h, COUNTRY)?.toUpperCase(),
    region: firstOf(h, REGION)?.toUpperCase(),
    device: deviceFromHeaders(h, ua),
    os: osFromUserAgent(ua),
    referrerHost: refererHost(h.get("referer")),
    language: primaryLanguage(h.get("accept-language")),
    at: now.toISOString(),
  };
}

function firstOf(h: Headers, names: string[]): string | undefined {
  for (const n of names) {
    const v = h.get(n);
    if (v) return v;
  }
  return undefined;
}

function deviceFromHeaders(h: Headers, ua: string): VisitorContext["device"] {
  // CloudFront can classify the device for us, which is both cheaper and more
  // consistent with what the cache key was built from.
  if (h.get("cloudfront-is-tablet-viewer") === "true") return "tablet";
  if (h.get("cloudfront-is-mobile-viewer") === "true") return "mobile";
  if (h.get("cloudfront-is-desktop-viewer") === "true") return "desktop";

  // Client hints next, user-agent sniffing only as a last resort.
  const mobileHint = h.get("sec-ch-ua-mobile");
  if (mobileHint === "?1") return "mobile";
  if (mobileHint === "?0") return "desktop";

  if (/\biPad\b|\bTablet\b/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  return "desktop";
}

export function osFromUserAgent(ua: string): VisitorContext["os"] {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

function refererHost(referer: string | null): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function primaryLanguage(accept: string | null): string | undefined {
  if (!accept) return undefined;
  const first = accept.split(",")[0]?.trim().split(";")[0];
  if (!first) return undefined;
  return first.split("-")[0]?.toLowerCase();
}

/**
 * Cache-Control for a resolved page.
 *
 * s-maxage is the evaluator's answer to "when could this decision change?",
 * clamped only to guard against a profile with no time rules pinning a variant
 * indefinitely. stale-while-revalidate is deliberately generous: a visitor
 * seeing a page that is a few seconds out of date is a much better outcome than
 * a visitor waiting on a Lambda cold start.
 */
export function cacheControlFor(sMaxAge: number): string {
  const ceiling = Number(process.env.MAX_S_MAXAGE ?? 3600);
  const s = Math.max(0, Math.min(Math.floor(sMaxAge), ceiling));
  if (s === 0) return "public, max-age=0, s-maxage=0, must-revalidate";
  const swr = Math.min(600, Math.max(30, Math.floor(s / 2)));
  return `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${swr}`;
}
