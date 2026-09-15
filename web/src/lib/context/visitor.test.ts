import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheControlFor } from "./visitor";

describe("cacheControlFor with a bad ceiling", () => {
  const original = process.env.MAX_S_MAXAGE;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MAX_S_MAXAGE;
    else process.env.MAX_S_MAXAGE = original;
    vi.restoreAllMocks();
  });

  it("never lets a non-numeric env value reach the header", () => {
    // "1h" reads fine to a human and used to produce s-maxage=NaN, which every
    // cache drops along with the rest of the directive.
    for (const value of ["1h", "", "abc", "-30", "0", "NaN"]) {
      process.env.MAX_S_MAXAGE = value;
      const header = cacheControlFor(300);
      expect(header, value).not.toContain("NaN");
      expect(header, value).toContain("s-maxage=300");
    }
  });

  it("falls back to the default ceiling, and says so once", () => {
    process.env.MAX_S_MAXAGE = "one hour";
    expect(cacheControlFor(86_400)).toContain("s-maxage=3600");
    expect(console.warn).toHaveBeenCalledTimes(1);
    cacheControlFor(86_400);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("still honours a usable ceiling", () => {
    process.env.MAX_S_MAXAGE = "120";
    expect(cacheControlFor(900)).toContain("s-maxage=120");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("treats a boundary that is not a number as uncacheable", () => {
    for (const ttl of [NaN, Infinity, -Infinity]) {
      expect(cacheControlFor(ttl)).toBe("public, max-age=0, s-maxage=0, must-revalidate");
    }
  });
});
