import { describe, expect, it } from "vitest";
import { HANDLE_VALIDATOR_SOURCE, renderHomeDocument } from "./home";
import { RESERVED_HANDLES, handleProblem } from "@/lib/handles";
import { DEVICES, GEO_BUCKETS, REFERRERS } from "@/lib/rules/schema";

/**
 * The homepage restates things that live elsewhere — the rule vocabulary, the
 * dimension buckets, the handle rules — because it has to run them in a
 * browser with no imports. Every one of those copies is a place the page can
 * start lying about the product, and the lie is invisible: the page still
 * renders, it just promises a rule the evaluator cannot run or accepts a
 * handle the claim then refuses.
 *
 * So each copy is checked against its source here. These tests are not about
 * the page looking right; they are about it not drifting.
 */

const page = () => renderHomeDocument({ origin: "https://chamelink.app" });

describe("renderHomeDocument", () => {
  it("inlines exactly the bytes it hands back for hashing", () => {
    const { html, style, script } = page();
    // `app/route.ts` hashes `style` and `script` into the CSP. If the document
    // contains anything else between those tags, the page ships with its own
    // stylesheet and its own script blocked — and nothing else would fail.
    expect(html).toContain(`<style>${style}</style>`);
    expect(html).toContain(`<script>${script}</script>`);
  });

  it("closes neither block early", () => {
    const { style, script } = page();
    expect(style).not.toContain("</style");
    expect(script).not.toContain("</script");
  });

  it("loads nothing from anywhere", () => {
    const { html } = page();
    // `default-src 'none'` means an external subresource is not a slow page,
    // it is a missing one. The public profile ships no stylesheet and no
    // webfont for LCP reasons; this page holds the same line.
    expect(html).not.toMatch(/<script[^>]+\ssrc=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  it("names the origin it was actually served on", () => {
    const { html } = renderHomeDocument({ origin: "https://d123.cloudfront.net" });
    expect(html).toContain('<link rel="canonical" href="https://d123.cloudfront.net">');
    expect(html).toContain('<meta property="og:url" content="https://d123.cloudfront.net">');
  });

  it("emits a script that parses", () => {
    // The script is assembled as a template literal inside a TypeScript file,
    // so a stray backtick or a mis-escaped sequence produces a document that
    // renders perfectly and does nothing. `new Function` compiles without
    // running, which is exactly the half that can fail silently in a browser.
    expect(() => new Function(page().script)).not.toThrow();
  });

  it("sets no colour through a style attribute or the CSSOM", () => {
    // A CSP hash covers a <style> block. It does not cover `style="..."` on an
    // element and it cannot: the browser wants 'unsafe-hashes' for that, which
    // would weaken the policy for the whole page. This shipped broken once —
    // thirteen `style="--dim:…"` attributes, every one refused, the dimension
    // rails silently uncoloured and the page otherwise perfect.
    const { html, script } = page();
    expect(html).not.toMatch(/\sstyle="/);
    expect(script).not.toContain("style.setProperty");
    expect(script).not.toContain(".style.");
  });

  it("leaves no interpolation unresolved", () => {
    expect(page().html).not.toContain("${");
  });

  it("renders one dial per dimension the evaluator reads", () => {
    const dials = [...page().html.matchAll(/<div class="dial"[^>]*data-dim="([a-z]+)"/g)]
      .map((m) => m[1]);
    expect(dials).toEqual(["geo", "device", "referrer", "lang", "webview", "time"]);
  });

  it("is indexable", () => {
    // The whole reason this is a route handler and not a page: `app/layout.tsx`
    // sets robots noindex on everything it wraps.
    expect(page().html).not.toMatch(/name="robots"/);
  });
});

describe("the demo speaks the product's vocabulary", () => {
  const { html, script } = page();

  it("uses only actions a rule can actually take", () => {
    // `show` and `promote` were removed from the schema because neither was an
    // action — a rule that does not match leaves a block alone, and ordering is
    // rank. A demo that showed either would be teaching a rule nobody can write.
    // Scoped to the rule set: the trace also carries `act:"keep"`, which is a
    // label for a rule that matched nothing, not a fourth action.
    const rules = script.match(/var RULES=\[[\s\S]*?\}\];/)?.[0] ?? "";
    expect(rules).not.toBe("");
    const acts = [...rules.matchAll(/\bact:"([a-z]+)"/g)].map((m) => m[1] ?? "");
    expect(acts.length).toBeGreaterThan(0);
    expect(new Set(acts)).toEqual(new Set(["hide", "redirect"]));
  });

  const optionsOf = (id: string): string[] => {
    const select = html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`));
    expect(select).not.toBeNull();
    return [...select![0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1] ?? "");
  };

  it("offers exactly the geo buckets the evaluator has", () => {
    expect(optionsOf("d-geo")).toEqual([...GEO_BUCKETS]);
  });

  it("offers exactly the devices the evaluator has", () => {
    expect(optionsOf("d-device")).toEqual([...DEVICES]);
  });

  it("offers exactly the referrer classes the evaluator has", () => {
    // Same list and, more importantly, the same tokens: the cache key on screen
    // is built from these, and `ig` in a mockup that the edge calls `insta`
    // would be a key nobody could match against a real one.
    expect(new Set(optionsOf("d-ref"))).toEqual(new Set(REFERRERS));
  });
});

describe("the claim field answers what the backend would answer", () => {
  const { script } = page();

  /** The emitted bytes, run as the browser will run them. */
  const problem = new Function(`${HANDLE_VALIDATOR_SOURCE}; return problem;`)() as (
    raw: string,
    reserved: string[],
  ) => string | null;

  const reserved = (() => {
    const m = script.match(/var RESERVED=(\[[^\]]*\]);/);
    expect(m).not.toBeNull();
    return JSON.parse(m![1] ?? "[]") as string[];
  })();

  it("ships the real reserved list, not a copy of it", () => {
    expect(new Set(reserved)).toEqual(RESERVED_HANDLES);
  });

  const corpus = [
    // valid
    "ava", "a1", "giorgi", "x_y", "a-b", "a_b-c9", "0ava", "ab".repeat(15),
    // length
    "", "a", "ab".repeat(15) + "z",
    // reserved, including the ones only this app reserves
    ...RESERVED_HANDLES,
    // shape
    "-ava", "ava-", "_ava", "ava_", "a--b", "a__b", "a-_b", "a_-b",
    "AVA", "  Ava  ", "av a", "av.a", "av!a", "avá", "ava​",
  ];

  it.each(corpus)("agrees with handleProblem on %j", (input) => {
    expect(problem(input, reserved)).toBe(handleProblem(input));
  });
});
