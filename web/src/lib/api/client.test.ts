import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, geoBucket, referrerCode, toWireContext } from "./client";
import { ApiError } from "./types";
import { reducer } from "@/components/editor/profile-store";

/**
 * The three things that were quietly wrong, pinned.
 *
 * A 204 that read as failure, a 409 that could not say which kind it was, and a
 * conflict lock cleared by the rollback that followed it. None of them threw,
 * none of them logged, and all three showed up as the editor doing something
 * the creator did not ask for.
 */

const ORIGIN = "http://api.test";

/** One canned response, plus a record of what was sent to get it. */
function stubFetch(responses: Array<{ status: number; body?: unknown; contentType?: string }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, {
      status: r.status,
      headers: { "content-type": r.contentType ?? "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  process.env.API_ORIGIN = ORIGIN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("204 handling", () => {
  it("treats an empty body as success on a delete", async () => {
    stubFetch([{ status: 204 }]);
    // The bug: `undefined as T` came back and every caller read it as failure,
    // so a delete that had already happened was rolled back on screen.
    await expect(api.deleteBlock("p_1", "blk_1", { version: 3 })).resolves.toBeUndefined();
  });

  it("sends the version it was handed as If-Match", async () => {
    const calls = stubFetch([{ status: 204 }]);
    await api.deleteBlock("p_1", "blk_1", { version: 7 });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers["if-match"]).toBe("7");
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/profiles/p_1/blocks/blk_1`);
  });

  it("refuses to hand back an empty body where one was expected", async () => {
    stubFetch([{ status: 204 }]);
    // Better a loud error than a `Mutation<Block>` that is actually undefined.
    await expect(api.publish("p_1")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("409 handling", () => {
  const problem = (title: string, extra: Record<string, unknown> = {}) => ({
    status: 409,
    contentType: "application/problem+json",
    body: {
      type: `https://errors.linkbio.dev/${title}`,
      title,
      status: 409,
      detail: "something is in the way",
      ...extra,
    },
  });

  it("reads a stale If-Match as a version conflict, and carries the current version", async () => {
    stubFetch([problem("version_conflict", { current: 12 })]);
    const err = await api.publish("p_1", { version: 9 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isVersionConflict).toBe(true);
    expect((err as ApiError).isConflict).toBe(false);
    expect((err as ApiError).current).toBe(12);
  });

  it("does not read the block limit as a version conflict", async () => {
    stubFetch([problem("conflict")]);
    // Same status, different meaning. Keying on 409 told a creator who had hit
    // the block cap that the page had changed somewhere else, and locked the
    // editor until they reloaded — which of course did not help.
    const err = await api
      .createBlock("p_1", { kind: "link", label: "x" }, { version: 3 })
      .catch((e: unknown) => e);
    expect((err as ApiError).isVersionConflict).toBe(false);
    expect((err as ApiError).isConflict).toBe(true);
    expect((err as ApiError).message).toBe("something is in the way");
  });

  it("does not read a taken handle as a version conflict either", async () => {
    stubFetch([problem("conflict")]);
    const err = await api.claimHandle("p_1", "giorgi", { version: 3 }).catch((e: unknown) => e);
    expect((err as ApiError).isVersionConflict).toBe(false);
  });

  it("survives a 409 that is not problem+json at all", async () => {
    stubFetch([{ status: 409, body: { message: "Cross-origin request refused." } }]);
    // The proxy answers this way when it refuses a request before it ever
    // reaches the backend, so there is no `title` to key on.
    const err = await api.publish("p_1", { version: 1 }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBeNull();
    expect((err as ApiError).isVersionConflict).toBe(false);
    expect((err as ApiError).message).toBe("Cross-origin request refused.");
  });
});

describe("request shaping", () => {
  it("sends the whole rule set to the block's own endpoint", async () => {
    const calls = stubFetch([
      { status: 200, body: { data: { id: "blk_1", rules: [] }, version: 4, cacheDimensions: ["geo"] } },
    ]);
    await api.saveBlockRules(
      "p_1",
      "blk_1",
      [{ id: "r1", priority: 10, when: [{ dim: "geo", in: ["eu"] }], then: { kind: "hide" } }],
      { version: 3 },
    );
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/profiles/p_1/blocks/blk_1/rules`);
    // An array, not an object wrapping one: `RuleSet` is the body.
    expect(JSON.parse(calls[0]!.body!)).toHaveLength(1);
  });

  it("omits the neighbour it is not using, rather than sending null", async () => {
    const calls = stubFetch([
      { status: 200, body: { data: { id: "blk_1" }, version: 2, cacheDimensions: [] } },
    ]);
    await api.moveBlock("p_1", "blk_1", { afterId: null, beforeId: "blk_0" });
    // `MoveBlock` refines on "provide beforeId or afterId", and a null key is
    // still a key present.
    expect(JSON.parse(calls[0]!.body!)).toEqual({ beforeId: "blk_0" });
  });
});

describe("visitor context, coarsened the way the edge coarsens it", () => {
  it("buckets a country the same way edge/normalize.js does", () => {
    expect(geoBucket("US")).toBe("na");
    expect(geoBucket("de")).toBe("eu");
    expect(geoBucket("GE")).toBe("xx"); // not in the table: everything else
    expect(geoBucket(undefined)).toBeUndefined();
  });

  it("classifies a referrer host into the eight codes", () => {
    expect(referrerCode("www.instagram.com")).toBe("ig");
    expect(referrerCode("t.co")).toBe("x");
    expect(referrerCode("some.blog")).toBe("oth");
    expect(referrerCode("")).toBe("dir");
    expect(referrerCode(undefined)).toBeUndefined();
  });

  it("drops what the cache key cannot carry and sends time as epoch ms", () => {
    const at = "2026-03-01T12:00:00.000Z";
    const wire = toWireContext({
      country: "FR",
      region: "IDF",
      os: "ios",
      device: "mobile",
      referrerHost: "instagram.com",
      language: "fr-FR",
      at,
    });
    expect(wire).toEqual({
      geo: "eu",
      device: "mobile",
      referrer: "ig",
      lang: "fr",
      webview: undefined,
      at: Date.parse(at),
    });
    // `region` and `os` have no slot in the mask, so they are not smuggled
    // through under another name.
    expect(wire).not.toHaveProperty("region");
    expect(wire).not.toHaveProperty("os");
  });
});

/* ───────────────────────────────────────────────────────── the reducer ──── */

const PROFILE = {
  id: "p_1",
  handle: "giorgi",
  displayName: "Giorgi",
  bio: "",
  mode: "standard" as const,
  theme: { preset: "paper" as const, accent: "#000", typeface: "system" as const, cornerStyle: "soft" as const },
  blocks: [],
  version: 4,
  cacheDimensions: [],
  publishedVersion: 4,
};

const START = { profile: PROFILE, pending: new Set<string>(), conflict: false, error: null };

describe("the conflict lock", () => {
  it("is set by a conflict and survives the rollback that follows it", () => {
    // The exact sequence updateProfileFields runs: optimistic replace, the
    // write comes back 409, roll back. "replace" used to clear `conflict`, so
    // the rollback undid the lock and the banner never appeared.
    const optimistic = reducer(START, { type: "replace", profile: { ...PROFILE, displayName: "G" } });
    const locked = reducer(optimistic, { type: "conflict" });
    const rolled = reducer(locked, { type: "rollback", profile: PROFILE });

    expect(rolled.conflict).toBe(true);
    expect(rolled.profile.displayName).toBe("Giorgi");
  });

  it("is not cleared by a later successful-looking replace either", () => {
    const locked = reducer(START, { type: "conflict" });
    expect(reducer(locked, { type: "replace", profile: PROFILE }).conflict).toBe(true);
  });

  it("is cleared only by a reload, which is the one thing that resolves it", () => {
    const locked = reducer(START, { type: "conflict" });
    const fresh = reducer(locked, { type: "loaded", profile: { ...PROFILE, version: 12 } });
    expect(fresh.conflict).toBe(false);
    expect(fresh.profile.version).toBe(12);
  });

  it("clears the error banner on a reload but leaves it alone on a rollback", () => {
    const failed = reducer(START, { type: "error", message: "That didn't save." });
    expect(reducer(failed, { type: "rollback", profile: PROFILE }).error).toBe("That didn't save.");
    expect(reducer(failed, { type: "loaded", profile: PROFILE }).error).toBeNull();
  });

  it("takes version and cache mask only from the server", () => {
    const applied = reducer(START, { type: "apply", version: 9, cacheDimensions: ["geo", "time"] });
    expect(applied.profile.version).toBe(9);
    expect(applied.profile.cacheDimensions).toEqual(["geo", "time"]);
  });
});
