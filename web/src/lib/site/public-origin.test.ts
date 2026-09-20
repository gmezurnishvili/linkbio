import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin } from "./public-origin";
import { isSameOrigin } from "@/lib/auth/same-origin";

/**
 * Behind CloudFront this app runs on a Lambda function URL, so `request.url`
 * names a hostname no visitor ever typed. Two things break silently if that is
 * taken at face value: the canonical URL on a public page, and — much worse —
 * the same-origin check, which would then reject every write the dashboard
 * makes.
 */

const FN_URL = "https://abc123.lambda-url.us-east-1.on.aws/app/p1";
const CDN = "d111111abcdef8.cloudfront.net";

const fromEdge = (over: Record<string, string> = {}) =>
  new Headers({ "x-forwarded-host": CDN, "x-forwarded-proto": "https", ...over });

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_ORIGIN;
});

describe("publicOrigin", () => {
  it("prefers a configured site origin", () => {
    process.env.NEXT_PUBLIC_SITE_ORIGIN = "https://links.example.com";
    expect(publicOrigin(fromEdge(), FN_URL)).toBe("https://links.example.com");
  });

  it("ignores a malformed configured value rather than throwing on a page request", () => {
    process.env.NEXT_PUBLIC_SITE_ORIGIN = "not a url";
    expect(publicOrigin(fromEdge(), FN_URL)).toBe(`https://${CDN}`);
  });

  it("uses the forwarded viewer host, not the function URL", () => {
    expect(publicOrigin(fromEdge(), FN_URL)).toBe(`https://${CDN}`);
  });

  it("falls back to the request's own origin when nothing was forwarded", () => {
    expect(publicOrigin(new Headers(), FN_URL)).toBe("https://abc123.lambda-url.us-east-1.on.aws");
    expect(publicOrigin(new Headers(), "http://localhost:3000/app")).toBe("http://localhost:3000");
  });

  it("keeps a port on the forwarded host", () => {
    expect(publicOrigin(fromEdge({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" }), FN_URL))
      .toBe("http://localhost:3000");
  });

  it("refuses a forwarded host that is not a hostname", () => {
    // Belt and braces. The edge function deletes any viewer-sent copy before
    // writing its own and the function URL is only reachable through
    // CloudFront, but a value that could carry a path or a scheme should never
    // become an origin.
    for (const bad of ["evil.com/path", "https://evil.com", "a b", "evil.com:notaport", ""]) {
      expect(publicOrigin(fromEdge({ "x-forwarded-host": bad }), FN_URL))
        .toBe("https://abc123.lambda-url.us-east-1.on.aws");
    }
  });

  it("refuses a forwarded protocol that is not http or https", () => {
    expect(publicOrigin(fromEdge({ "x-forwarded-proto": "javascript" }), FN_URL))
      .toBe("https://abc123.lambda-url.us-east-1.on.aws");
  });

  it("takes the first entry of a comma-joined protocol", () => {
    expect(publicOrigin(fromEdge({ "x-forwarded-proto": "https, http" }), FN_URL)).toBe(`https://${CDN}`);
  });
});

describe("isSameOrigin behind a function URL", () => {
  const write = (origin: string | null, headers = fromEdge()) => {
    const h = new Headers(headers);
    if (origin) h.set("origin", origin);
    return isSameOrigin(new Request(FN_URL, { method: "POST", headers: h }));
  };

  it("accepts the CDN origin the browser actually sends", () => {
    // Without the forwarded host this is the regression: the browser sends the
    // CDN origin, `request.url` is the function URL, and every save 403s.
    expect(write(`https://${CDN}`)).toBe(true);
  });

  it("still accepts the request's own origin, which is all there is locally", () => {
    expect(
      isSameOrigin(
        new Request("http://localhost:3000/api/proxy/v1/profiles", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        }),
      ),
    ).toBe(true);
  });

  it("refuses another origin, and refuses one that is missing", () => {
    expect(write("https://evil.example")).toBe(false);
    expect(write(null)).toBe(false);
  });

  it("refuses a scheme downgrade of our own host", () => {
    expect(write(`http://${CDN}`)).toBe(false);
  });
});

describe("isSameOrigin via Sec-Fetch-Site", () => {
  const post = (headers: Record<string, string>) =>
    isSameOrigin(new Request(FN_URL, { method: "POST", headers: new Headers(headers) }));

  it("accepts same-origin without needing to know its own origin", () => {
    // No Origin, no forwarded host, nothing configured — and still correct.
    expect(post({ "sec-fetch-site": "same-origin" })).toBe(true);
  });

  it("refuses cross-site even when Origin says otherwise", () => {
    // A script cannot set Sec-Fetch-Site; it can put anything in Origin.
    expect(post({ "sec-fetch-site": "cross-site", origin: `https://${CDN}` })).toBe(false);
    expect(post({ "sec-fetch-site": "same-site", origin: `https://${CDN}` })).toBe(false);
    expect(post({ "sec-fetch-site": "none", origin: `https://${CDN}` })).toBe(false);
  });

  it("falls back to the origin comparison when the browser does not send it", () => {
    expect(post({ origin: `https://${CDN}`, "x-forwarded-host": CDN })).toBe(true);
    expect(post({ origin: "https://evil.example", "x-forwarded-host": CDN })).toBe(false);
  });
});
