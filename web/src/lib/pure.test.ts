import { describe, expect, it } from "vitest";
import { byRank, rankBetween } from "./rank";
import { windowWarnings } from "./rules/dst";
import { cacheControlFor, osFromUserAgent } from "./context/visitor";
import { deriveCacheDimensions, estimateVariants } from "./rules/language";
import { esc, varyHeader } from "./site/render";
import { handleProblem, isReserved } from "./handles";
import type { TimeWindow } from "./api/types";
import type { BlockRule } from "./rules/schema";

describe("rankBetween", () => {
  it("lands strictly between its bounds", () => {
    const mid = rankBetween("a", "c");
    expect(mid > "a").toBe(true);
    expect(mid < "c").toBe(true);
  });

  it("handles an open lower bound", () => {
    expect(rankBetween(null, "b") < "b").toBe(true);
  });

  it("handles an open upper bound", () => {
    expect(rankBetween("y", null) > "y").toBe(true);
  });

  it("descends a digit when there is no room at this position", () => {
    const mid = rankBetween("a", "b");
    expect(mid > "a").toBe(true);
    expect(mid < "b").toBe(true);
    expect(mid.length).toBeGreaterThan(1);
  });

  it("stays sortable across repeated splits at the same seam", () => {
    let lo = "a";
    const hi = "b";
    const seen: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const next = rankBetween(lo, hi);
      expect(next > lo).toBe(true);
      expect(next < hi).toBe(true);
      seen.push(next);
      lo = next;
    }
    expect([...seen].sort()).toEqual(seen);
  });

  it("refuses inverted bounds rather than minting a bad key", () => {
    expect(() => rankBetween("c", "a")).toThrow();
  });

  it("sorts blocks by rank as strings", () => {
    const list = [{ rank: "b" }, { rank: "a" }, { rank: "a5" }];
    expect(list.sort(byRank).map((x) => x.rank)).toEqual(["a", "a5", "b"]);
  });
});

describe("DST advisory warnings", () => {
  const base: TimeWindow = {
    timezone: "America/New_York",
    daysOfWeek: [],
    start: "02:15",
    end: "02:45",
  };

  // Spring 2027 forward: 2027-03-14, 02:00 -> 03:00 local.
  const springStart = Date.parse("2027-01-01T00:00:00Z");

  it("flags a window inside the spring-forward gap", () => {
    const warnings = windowWarningsFrom(base, springStart);
    expect(warnings.some((w) => w.code === "dst-gap")).toBe(true);
    expect(warnings[0]?.message).toContain("02:00");
  });

  it("flags a window inside the fall-back repeat", () => {
    const window: TimeWindow = { ...base, start: "01:15", end: "01:45" };
    const warnings = windowWarningsFrom(window, springStart);
    expect(warnings.some((w) => w.code === "dst-ambiguous")).toBe(true);
  });

  it("stays quiet for a window nowhere near a transition", () => {
    const window: TimeWindow = { ...base, start: "09:00", end: "17:00" };
    expect(windowWarningsFrom(window, springStart)).toEqual([]);
  });

  it("stays quiet for a zone without transitions", () => {
    const window: TimeWindow = { ...base, timezone: "Asia/Tokyo" };
    expect(windowWarningsFrom(window, springStart)).toEqual([]);
  });

  it("says nothing about visitor-local windows, which the server resolves", () => {
    expect(windowWarnings({ ...base, timezone: "viewer" })).toEqual([]);
  });
});

/** windowWarnings scans forward from now; tests need a fixed starting point. */
function windowWarningsFrom(window: TimeWindow, from: number) {
  const original = Date.now;
  Date.now = () => from;
  try {
    return windowWarnings(window);
  } finally {
    Date.now = original;
  }
}

describe("cacheControlFor", () => {
  it("passes the evaluator's boundary through", () => {
    expect(cacheControlFor(300)).toContain("s-maxage=300");
  });

  it("clamps to the ceiling so a rule-free page cannot pin a variant", () => {
    process.env.MAX_S_MAXAGE = "600";
    expect(cacheControlFor(86_400)).toContain("s-maxage=600");
  });

  it("makes a zero boundary uncacheable rather than nearly so", () => {
    expect(cacheControlFor(0)).toContain("must-revalidate");
  });

  it("floors fractional seconds instead of rounding up past the boundary", () => {
    expect(cacheControlFor(59.9)).toContain("s-maxage=59");
  });
});

describe("cache dimension derivation", () => {
  const rule = (id: string, when: BlockRule["when"]): BlockRule => ({
    id,
    priority: 10,
    when,
    then: { kind: "hide" },
  });

  it("collects the dimension of every condition on the page", () => {
    // There is no enabled flag any more: a saved rule is a live rule, and the
    // way to stop one applying is to delete it.
    const rules = [
      rule("r1", [{ dim: "geo", in: ["na"] }]),
      rule("r2", [{ dim: "device", in: ["mobile"] }]),
    ];
    expect(deriveCacheDimensions(rules)).toEqual(["geo", "device"]);
  });

  it("reports a time window, which bounds the TTL rather than splitting the key", () => {
    // `cacheDimensionsFor` in api/src/publish.ts appends `time` outside the
    // mask for exactly this reason, and the cost panel is about both.
    const rules = [rule("r1", [{ dim: "time", tz: "Europe/Berlin", from: "18:00", to: "23:00" }])];
    expect(deriveCacheDimensions(rules)).toEqual(["time"]);
  });

  it("counts each named value plus a fallthrough bucket", () => {
    const rules = [
      rule("r1", [{ dim: "geo", in: ["na", "eu"] }]),
      rule("r2", [{ dim: "device", in: ["mobile"] }]),
    ];
    expect(estimateVariants(rules)).toBe(6);
  });

  it("gives a boolean two buckets, not three", () => {
    // `webview` has nothing to fall through to, so the +1 above would be
    // inventing a third kind of visitor.
    expect(estimateVariants([rule("r1", [{ dim: "webview", is: true }])])).toBe(2);
  });
});

describe("html rendering", () => {
  it("escapes creator input", () => {
    expect(esc(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });

  it("maps cache dimensions onto viewer headers", () => {
    expect(varyHeader(["country", "language"])).toBe(
      "CloudFront-Viewer-Country, Accept-Language",
    );
  });

  it("covers every dimension the backend reports", () => {
    // geo, lang and webview used to fall out of the map and be dropped by a
    // `.filter(Boolean)`, so a page keyed on all three shipped no Vary at all.
    expect(varyHeader(["geo", "lang", "webview"])).toBe(
      "CloudFront-Viewer-Country, Accept-Language, User-Agent",
    );
  });

  it("does not repeat a header two dimensions share", () => {
    expect(varyHeader(["lang", "language"])).toBe("Accept-Language");
  });

  it("leaves time out: it bounds the TTL rather than splitting the key", () => {
    expect(varyHeader(["time"])).toBeNull();
    expect(varyHeader(["geo", "time"])).toBe("CloudFront-Viewer-Country");
  });

  it("widens to * for a dimension it cannot express, rather than dropping it", () => {
    expect(varyHeader(["geo", "hour-of-day"])).toBe("*");
  });

  it("omits vary entirely when nothing fragments", () => {
    expect(varyHeader([])).toBeNull();
  });
});

describe("user agent parsing", () => {
  it("reads the platform, not the browser", () => {
    expect(osFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Instagram 300.0")).toBe(
      "ios",
    );
    expect(osFromUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120")).toBe("android");
    expect(osFromUserAgent("curl/8.4.0")).toBe("other");
  });
});

describe("handles", () => {
  it("accepts ordinary handles", () => {
    for (const h of ["giorgi", "g1", "dj-giorgi", "a_b_c"]) {
      expect(handleProblem(h)).toBeNull();
    }
  });

  it("rejects dots, which the backend's claim would reject anyway", () => {
    expect(handleProblem("giorgi.official")).not.toBeNull();
    expect(handleProblem("giorgi..official")).not.toBeNull();
    expect(handleProblem("giorgi.")).not.toBeNull();
  });

  it("rejects near-duplicate shapes that read as impersonation", () => {
    expect(handleProblem("-giorgi")).not.toBeNull();
    expect(handleProblem("giorgi--official")).not.toBeNull();
  });

  it("rejects lengths outside the claimable range", () => {
    expect(handleProblem("x")).not.toBeNull();
    expect(handleProblem("a".repeat(31))).not.toBeNull();
    expect(handleProblem("a".repeat(30))).toBeNull();
  });

  it("keeps product paths out of creators' hands", () => {
    expect(isReserved("app")).toBe(true);
    expect(isReserved("ADMIN")).toBe(true);
    expect(isReserved("giorgi")).toBe(false);
  });
});
