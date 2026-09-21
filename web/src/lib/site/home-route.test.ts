import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/route";
import { renderHomeDocument } from "./home";

/**
 * The route handler, exercised the way CloudFront calls it.
 *
 * The test lives here rather than beside `app/route.ts` so nothing that is not
 * a route sits in the app directory.
 *
 * Behind the CDN this runs on a Lambda function URL, so `request.url` names a
 * hostname no visitor typed — the canonical URL has to come from
 * `x-forwarded-host`, which `api/edge/page.js` writes and
 * `lib/site/public-origin.ts` validates.
 */

const FN_URL = "https://abc123.lambda-url.us-east-1.on.aws/";
const CDN = "chamelink.app";

const fromEdge = (over: Record<string, string> = {}) =>
  new Request(FN_URL, {
    headers: { "x-forwarded-host": CDN, "x-forwarded-proto": "https", ...over },
  });

const sha256 = (s: string) =>
  `sha256-${createHash("sha256").update(s, "utf8").digest("base64")}`;

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_ORIGIN;
});

describe("GET /", () => {
  it("answers with a document instead of a 404", async () => {
    const res = await GET(fromEdge());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(res.text()).resolves.toContain("<!DOCTYPE html>");
  });

  it("canonicalises to the host the viewer typed, not the function URL", async () => {
    const html = await (await GET(fromEdge())).text();
    expect(html).toContain(`<link rel="canonical" href="https://${CDN}">`);
    expect(html).not.toContain("lambda-url");
  });

  it("hashes the blocks it actually inlined", async () => {
    // The one failure mode this file exists for: a hash computed from a second,
    // hopefully-identical copy of the CSS stops matching the moment a token
    // changes, and the page ships with its own styles blocked. Nothing else
    // reports it — the HTML is a 200 either way.
    const res = await GET(fromEdge());
    const html = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";

    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(style).not.toBe("");
    expect(script).not.toBe("");

    expect(csp).toContain(`style-src '${sha256(style)}'`);
    expect(csp).toContain(`script-src '${sha256(script)}'`);
  });

  it("matches the renderer's own output for the same origin", async () => {
    process.env.NEXT_PUBLIC_SITE_ORIGIN = `https://${CDN}`;
    const html = await (await GET(fromEdge())).text();
    expect(html).toBe(renderHomeDocument({ origin: `https://${CDN}` }).html);
  });

  it("keeps the claim form working under the policy", async () => {
    // The form is a plain GET to /signup so it survives a blocked script.
    // `form-action 'none'`, which the profile page uses, would break it and
    // nothing would say so.
    const res = await GET(fromEdge());
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain('method="get" action="/signup"');
  });

  it("is cacheable at the edge but not for longer than a deploy cycle", async () => {
    // Nothing in this repo issues a CloudFront invalidation, and the homepage
    // has no publish event to purge it, so the TTL is the whole mechanism.
    const cc = (await GET(fromEdge())).headers.get("cache-control") ?? "";
    expect(cc).toMatch(/^public, max-age=0, s-maxage=(\d+), stale-while-revalidate=\d+$/);
    const sMaxAge = Number(cc.match(/s-maxage=(\d+)/)![1]);
    expect(sMaxAge).toBeGreaterThan(0);
    expect(sMaxAge).toBeLessThanOrEqual(3600);
  });
});
