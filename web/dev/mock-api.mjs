/**
 * Mock backend. Node only, no dependencies, no AWS.
 *
 *   node dev/mock-api.mjs        # listens on 8787
 *
 * It implements the same contract the Hono API in ../../api does: the same
 * paths, the same `{data, version, cacheDimensions}` envelope, RFC 9457
 * problem+json with the code in `title`, both flavours of 409, and refresh
 * rotation. Run the real one when you can — `DB_DRIVER=memory npm start` in
 * ../../api — and this when you want the frontend up on its own.
 *
 * The rule evaluation here is a stand-in, not a port. Three known divergences,
 * all in the same direction — this one is more optimistic than the real one:
 *
 *   - sMaxAge is found by scanning forward a minute at a time, where the real
 *     evaluator derives the boundary from the window edges and verifies each
 *     candidate by re-evaluating on both sides.
 *   - an ambiguous wall time is whatever Intl says, rather than being resolved
 *     by role (earlier instant for a start, later for an end).
 *   - `cacheable` is always true. The real one returns false, with s-maxage 0,
 *     when the edge cache mask does not cover a dimension the rules read —
 *     which is why a probe with no country header gets `s-maxage=0` from the
 *     API and 3600 from here.
 *
 * Anywhere the two disagree, the real one is right.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);

/* ---------------------------------------------------------------- state --- */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? 200);
const MAX_RULES = Number(process.env.MAX_RULES ?? 20);
const ACCESS_TTL = 900;

const RESERVED = new Set([
  "api", "admin", "www", "app", "login", "logout", "signup", "settings", "support",
  "help", "about", "terms", "privacy", "static", "assets", "r", "p", "v1", "health",
]);
const HANDLE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

const now = Date.now();

const state = {
  users: new Map([["you@studio.com", { userId: "u_1", email: "you@studio.com" }]]),
  /** token -> userId, for the access tokens this mock hands out. */
  sessions: new Map(),
  /** Live refresh tokens, by userId. Rotation consumes one and mints another. */
  refresh: new Map(),
  /** Handles given up by a rename, held for 90 days like the real tombstone. */
  tombstones: new Map(),
  profiles: [
    {
      id: "p_1",
      userId: "u_1",
      handle: "giorgi",
      title: "Giorgi",
      bio: "Producer. Tbilisi.",
      eventAt: undefined,
      theme: { preset: "paper", accent: "#1b4fd8", typeface: "grotesque", cornerStyle: "soft" },
      version: 12,
      // Seeded published, so /giorgi resolves the moment the mock is up.
      publishedVersion: 12,
      createdAt: now - 864e5,
      updatedAt: now - 864e5,
      blocks: [
        {
          id: "b_tour",
          profileId: "p_1",
          rank: "a0",
          kind: "feed",
          label: "Tour dates",
          hidden: false,
          // Ported to the backend's shape: the old rule said country in [US, CA]
          // with a "show" effect, which has no counterpart. The same intent —
          // this is for North America — is now "hide it from everyone else",
          // because a rule that does not match leaves the block alone.
          rules: [
            { id: "r_na", priority: 10, when: [{ dim: "geo", in: ["eu", "apac", "latam", "mea", "xx"] }], then: { kind: "hide" } },
          ],
          feed: { source: "rss", ref: "https://example.com/tour.xml", ttlSeconds: 3600 },
          feedRefreshedAt: now - 24e4,
          items: [
            { title: "Tbilisi — Mtkvarze", subtitle: "Oct 4", href: "https://example.com/t1" },
            { title: "Berlin — RSO", subtitle: "Oct 11", href: "https://example.com/t2" },
            { title: "London — Corsica", subtitle: "Oct 18", href: "https://example.com/t3" },
          ],
          createdAt: now - 864e5,
          updatedAt: now - 864e5,
        },
        {
          id: "b_presave",
          profileId: "p_1",
          rank: "a5",
          kind: "link",
          label: "Presave — new single",
          target: "https://open.spotify.com/album/demo",
          hidden: false,
          // Was "os in [ios] → rewrite". There is no os dimension; `webview`
          // is the axis that survived, and a redirect is now explicit about
          // which status it sends.
          rules: [
            {
              id: "r_webview",
              priority: 20,
              when: [{ dim: "webview", is: true }],
              then: { kind: "redirect", target: "https://music.apple.com/album/demo", status: 302 },
            },
          ],
          createdAt: now - 864e5,
          updatedAt: now - 864e5,
        },
        {
          id: "b_rsvp",
          profileId: "p_1",
          rank: "aG",
          // Was kind "gate", which the backend has no equivalent for.
          kind: "link",
          label: "Afterparty RSVP",
          target: "https://example.com/rsvp",
          hidden: false,
          rules: [
            {
              id: "r_late",
              priority: 30,
              // Crosses both midnight and, in November, the fall-back repeat —
              // useful for eyeballing what the real evaluator does with it.
              // Inverted from the old "show inside the window": the block is
              // hidden outside it.
              when: [{ dim: "time", tz: "America/New_York", days: [5, 6], from: "02:30", to: "22:00" }],
              then: { kind: "hide" },
            },
          ],
          createdAt: now - 864e5,
          updatedAt: now - 864e5,
        },
        {
          id: "b_merch",
          profileId: "p_1",
          rank: "aV",
          kind: "link",
          label: "Merch",
          target: "https://shop.example.com",
          hidden: false,
          rules: [],
          createdAt: now - 864e5,
          updatedAt: now - 864e5,
        },
      ],
    },
  ],
  events: [],
};

const profile = (id) => state.profiles.find((p) => p.id === id);
const byHandle = (handle) => state.profiles.find((p) => p.handle === String(handle).toLowerCase());

/* ---------------------------------------------------------------- errors --- */

/**
 * RFC 9457, with the code in `title`. The client keys its behaviour on that,
 * not on the status — two different 409s live below and only one of them means
 * "reload".
 */
function problem(status, code, detail, extra = {}) {
  return { status, problem: { type: `https://errors.linkbio.dev/${code}`, title: code, status, detail, ...extra } };
}

const badRequest = (d, errors) => problem(400, "bad_request", d, errors ? { errors } : {});
const unauthorized = (d = "missing or invalid credentials") => problem(401, "unauthorized", d);
const forbidden = () => problem(403, "forbidden", "not your resource");
const notFound = (d = "not found") => problem(404, "not_found", d);
/** The value is unusable: a taken handle, the block limit. Reloading changes nothing. */
const conflict = (d) => problem(409, "conflict", d);
/** A stale If-Match, and only that. `current` is what the client should reload to. */
const versionConflict = (current) =>
  problem(409, "version_conflict", "the page changed since you loaded it", { current });

/* ------------------------------------------------------------------ auth --- */

function issue(userId) {
  const accessToken = `dev.${randomUUID()}`;
  const refreshToken = `${userId}.${randomUUID()}`;
  state.sessions.set(accessToken, userId);
  // Rotation: whatever was live for this user is replaced, so the token being
  // exchanged is spent the moment a new one exists.
  state.refresh.set(userId, refreshToken);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL };
}

/** The bearer token's user, or null. Every /v1/profiles and /v1/me route needs one. */
function authed(req) {
  const raw = req.headers.authorization ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  return state.sessions.get(token) ?? null;
}

/* ------------------------------------------------------------ evaluation --- */

/** Cache-key dimensions implied by the live rules. Mirrors `cacheDimensionsFor`. */
function cacheDimensions(p) {
  const out = new Set();
  for (const b of p.blocks) {
    for (const r of b.rules ?? []) {
      for (const c of r.when) out.add(c.dim);
    }
  }
  // Fixed order, the way the real one derives it from the `gdrlw` mask.
  const ordered = ["geo", "device", "referrer", "lang", "webview"].filter((d) => out.has(d));
  return out.has("time") ? [...ordered, "time"] : ordered;
}

function localParts(timezone, instant) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(instant));
  const get = (t) => parts.find((x) => x.type === t)?.value ?? "";
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return { day: days[get("weekday")] ?? 0, minutes: hour * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":");
  return Number(h) * 60 + Number(m);
};

function timeActive(cond, instant) {
  const { day, minutes } = localParts(cond.tz, instant);
  const start = toMinutes(cond.from);
  const end = toMinutes(cond.to);
  const days = cond.days;
  if (end > start) {
    return (!days || days.includes(day)) && minutes >= start && minutes < end;
  }
  // Crosses midnight: the tail belongs to the previous day's window.
  const yesterday = (day + 6) % 7;
  if (minutes >= start) return !days || days.includes(day);
  if (minutes < end) return !days || days.includes(yesterday);
  return false;
}

function matches(c, ctx, instant) {
  if (c.dim === "time") return timeActive(c, instant);
  if (c.dim === "webview") return ctx.webview === c.is;
  const actual = ctx[c.dim];
  return actual !== undefined && c.in.includes(actual);
}

/** `pick` in api/src/rules/rules.ts: lowest priority first, ties by id. */
function pick(block, ctx, instant) {
  if (block.activeFrom && instant < block.activeFrom) return { action: { kind: "hide" }, ruleId: null };
  if (block.activeUntil && instant >= block.activeUntil) return { action: { kind: "hide" }, ruleId: null };
  const sorted = [...(block.rules ?? [])].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  for (const r of sorted) {
    if (r.when.every((c) => matches(c, ctx, instant))) return { action: r.then, ruleId: r.id };
  }
  return { action: { kind: "redirect", target: block.target ?? "", status: 302 }, ruleId: null };
}

/**
 * Seconds until the answer changes. Scanned rather than computed — the real
 * evaluator derives the boundary from the window edges directly and memoises
 * by condition and UTC day.
 */
function secondsToBoundary(p, ctx, instant) {
  const timed = p.blocks.flatMap((b) => (b.rules ?? []).flatMap((r) => r.when.filter((c) => c.dim === "time")));
  if (timed.length === 0) return 3600;
  const current = timed.map((c) => timeActive(c, instant));
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    const at = instant + minute * 60_000;
    if (timed.map((c) => timeActive(c, at)).some((v, i) => v !== current[i])) {
      return Math.max(5, minute * 60 - Math.floor((instant % 60_000) / 1000));
    }
  }
  return 3600;
}

function resolve(p, ctx, { trace: wantTrace, draft }) {
  const instant = draft && ctx.at ? ctx.at : Date.now();
  const trace = [];
  const blocks = [];
  const warnings = [];

  for (const b of [...p.blocks].sort((a, b) => (a.rank < b.rank ? -1 : 1))) {
    if (b.hidden) continue;
    const d = pick(b, ctx, instant);
    if (wantTrace) {
      trace.push({
        blockId: b.id,
        ruleId: d.ruleId,
        action: d.action.kind,
        reason: d.ruleId ? `rule ${d.ruleId} matched` : "no rule matched, using the default",
        sMaxAge: secondsToBoundary(p, ctx, instant),
      });
    }
    if (d.action.kind === "hide") continue;
    blocks.push({
      id: b.id,
      kind: b.kind,
      label: b.label,
      icon: b.icon,
      href: `/r/${p.handle}/${b.id}`,
      target: d.action.target,
      items: b.items,
    });
  }

  return {
    handle: p.handle,
    title: p.title,
    bio: p.bio,
    avatarUrl: p.avatarUrl,
    eventAt: p.eventAt,
    theme: p.theme,
    version: p.version,
    published: p.publishedVersion !== null,
    blocks,
    sMaxAge: secondsToBoundary(p, ctx, instant),
    cacheable: true,
    varyOn: cacheDimensions(p),
    ...(wantTrace ? { trace } : {}),
    warnings,
  };
}

/* ----------------------------------------------------------------- ranks --- */

function rankBetween(after, before) {
  const lo = after ? DIGITS.indexOf(after[0]) : 0;
  const hi = before ? DIGITS.indexOf(before[0]) : DIGITS.length - 1;
  if (hi - lo > 1) return DIGITS[Math.floor((lo + hi) / 2)];
  // No room at this position. The real backend rebalances; appending a
  // midpoint is enough to keep the dev list sorted.
  return `${after ?? DIGITS[lo]}${DIGITS[Math.floor(DIGITS.length / 2)]}`;
}

/* --------------------------------------------------------------- writes --- */

/**
 * The version gate every write goes through, matching `gate` in
 * api/src/routes/mutation.ts: If-Match is optional, but when it is present it
 * must equal the current version, and the version is bumped either way.
 *
 * The previous version of this said it required If-Match and then returned
 * false whenever the header was absent — so the whole optimistic-concurrency
 * story was untested against the mock, which is the one place it was cheap to
 * test.
 */
function gate(req, p) {
  const raw = req.headers["if-match"];
  if (raw !== undefined && raw !== "") {
    const expected = Number(String(raw).replace(/^W\//, "").replace(/"/g, ""));
    if (!Number.isInteger(expected) || expected < 0) {
      return badRequest("if-match must be a profile version");
    }
    if (expected !== p.version) return versionConflict(p.version);
  }
  p.version += 1;
  p.updatedAt = Date.now();
  return null;
}

/** `{data, version, cacheDimensions}` — the envelope every mutation answers with. */
const envelope = (p, data, status = 200) => ({
  status,
  body: { data, version: p.version, cacheDimensions: cacheDimensions(p) },
});

const publicProfile = (p) => {
  const { blocks, userId, ...rest } = p;
  return rest;
};

function handleState(handle, forProfileId) {
  const held = byHandle(handle);
  if (held) return held.id === forProfileId ? { status: "free" } : { status: "taken" };
  const tomb = state.tombstones.get(handle);
  if (tomb && tomb.until > Date.now()) {
    return tomb.profileId === forProfileId ? { status: "free" } : { status: "tombstoned" };
  }
  return { status: "free" };
}

/* --------------------------------------------------------------- routing --- */

const routes = [
  ["POST", /^\/v1\/auth\/register$/, (_req, body) => {
    const email = String(body?.email ?? "").toLowerCase();
    const password = String(body?.password ?? "");
    if (!email.includes("@") || password.length < 8) return badRequest("validation failed");
    if (state.users.has(email)) return conflict("email already registered");
    const userId = `u_${randomUUID().slice(0, 6)}`;
    state.users.set(email, { userId, email, password });
    return { status: 201, body: issue(userId) };
  }],

  ["POST", /^\/v1\/auth\/token$/, (_req, body) => {
    const email = String(body?.email ?? "").toLowerCase();
    const user = state.users.get(email);
    // The seeded account takes any password, so a fresh checkout can sign in.
    if (!user || (user.password && user.password !== String(body?.password ?? ""))) {
      return unauthorized("email or password is wrong");
    }
    return { status: 200, body: issue(user.userId) };
  }],

  /**
   * Rotation, with reuse detection. The presented token is consumed and a new
   * one issued; presenting a spent token is the signal that one leaked, so
   * every session for that user goes with it.
   */
  ["POST", /^\/v1\/auth\/refresh$/, (_req, body) => {
    const token = String(body?.refreshToken ?? "");
    const userId = token.split(".")[0] ?? "";
    if (!userId) return unauthorized("refresh token is not valid");
    if (state.refresh.get(userId) !== token) {
      state.refresh.delete(userId);
      for (const [access, owner] of state.sessions) {
        if (owner === userId) state.sessions.delete(access);
      }
      return unauthorized("refresh token is not valid");
    }
    return { status: 200, body: issue(userId) };
  }],

  ["GET", /^\/v1\/me$/, (req) => {
    const userId = authed(req);
    if (!userId) return unauthorized();
    const user = [...state.users.values()].find((u) => u.userId === userId);
    if (!user) return unauthorized("no such user");
    return {
      status: 200,
      body: {
        userId,
        email: user.email,
        profiles: state.profiles
          .filter((p) => p.userId === userId)
          .map((p) => ({ ...publicProfile(p), cacheDimensions: cacheDimensions(p) })),
      },
    };
  }],

  ["GET", /^\/v1\/handles\/([^/]+)$/, (_req, _body, [raw]) => {
    const handle = decodeURIComponent(raw).toLowerCase();
    if (RESERVED.has(handle)) return { status: 200, body: { available: false, reason: "reserved" } };
    if (handle.length < 2 || handle.length > 30 || !HANDLE.test(handle)) {
      return { status: 200, body: { available: false, reason: "invalid" } };
    }
    const st = handleState(handle, null);
    if (st.status === "free") return { status: 200, body: { available: true } };
    return { status: 200, body: { available: false, reason: st.status } };
  }],

  ["GET", /^\/v1\/profiles$/, (req) => {
    const userId = authed(req);
    if (!userId) return unauthorized();
    return {
      status: 200,
      body: {
        profiles: state.profiles
          .filter((p) => p.userId === userId)
          .map((p) => ({ ...publicProfile(p), cacheDimensions: cacheDimensions(p) })),
      },
    };
  }],

  ["POST", /^\/v1\/profiles$/, (req, body) => {
    const userId = authed(req);
    if (!userId) return unauthorized();
    const handle = String(body?.handle ?? "").toLowerCase();
    if (!HANDLE.test(handle) || handle.length < 2 || handle.length > 30 || RESERVED.has(handle)) {
      return badRequest("validation failed", [{ path: "handle", message: "invalid handle" }]);
    }
    if (!body?.title) return badRequest("validation failed", [{ path: "title", message: "required" }]);
    if (handleState(handle, null).status !== "free") return conflict("handle already claimed");

    const p = {
      id: `p_${randomUUID().slice(0, 6)}`,
      userId,
      handle,
      title: String(body.title),
      bio: body.bio,
      avatarUrl: body.avatarUrl,
      eventAt: body.eventAt,
      theme: body.theme,
      version: 1,
      // A new page is a draft. /p/:handle 404s until it is published.
      publishedVersion: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blocks: [],
    };
    state.profiles.push(p);
    return { status: 201, body: { data: publicProfile(p), version: p.version, cacheDimensions: [] } };
  }],

  ["GET", /^\/v1\/profiles\/([^/]+)$/, (req, _body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    return { status: 200, body: { ...publicProfile(p), blocks: p.blocks, cacheDimensions: cacheDimensions(p) } };
  }],

  ["PATCH", /^\/v1\/profiles\/([^/]+)$/, (req, body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const stale = gate(req, p);
    if (stale) return stale;
    for (const key of ["title", "bio", "avatarUrl", "eventAt"]) {
      if (body?.[key] !== undefined) p[key] = body[key];
    }
    if (body?.theme) p.theme = { ...p.theme, ...body.theme };
    return envelope(p, publicProfile(p));
  }],

  ["DELETE", /^\/v1\/profiles\/([^/]+)$/, (req, _body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    state.profiles = state.profiles.filter((p) => p.id !== id);
    return { status: 204, body: null };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/publish$/, (req, _body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const stale = gate(req, p);
    if (stale) return stale;
    p.publishedVersion = p.version;
    return envelope(p, publicProfile(p));
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/handle$/, (req, body, [id]) => claimHandle(req, body, id)],
  ["PUT", /^\/v1\/profiles\/([^/]+)\/handle$/, (req, body, [id]) => claimHandle(req, body, id)],

  ["POST", /^\/v1\/profiles\/([^/]+)\/preview$/, (req, body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    // Reads the draft and returns the trace, unlike the public path.
    return { status: 200, body: resolve(owned.profile, body ?? {}, { trace: true, draft: true }) };
  }],

  ["GET", /^\/v1\/profiles\/([^/]+)\/blocks$/, (req, _body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    return { status: 200, body: { blocks: owned.profile.blocks } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/blocks$/, (req, body, [id]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const shape = checkBlockShape({ kind: body?.kind ?? "link", ...body });
    if (shape) return shape;

    const stale = gate(req, p);
    if (stale) return stale;
    // A plain conflict, not a version one: reloading will not make room.
    if (p.blocks.length >= MAX_BLOCKS) return conflict(`block limit of ${MAX_BLOCKS} reached`);
    if (body?.after && !p.blocks.some((b) => b.id === body.after)) {
      return badRequest("after refers to an unknown block");
    }

    const sorted = [...p.blocks].sort((a, b) => (a.rank < b.rank ? -1 : 1));
    const i = body?.after ? sorted.findIndex((b) => b.id === body.after) : sorted.length - 1;
    const rank = rankBetween(sorted[i]?.rank ?? null, body?.after ? sorted[i + 1]?.rank ?? null : null);

    const block = {
      id: `blk_${randomUUID().slice(0, 8)}`,
      profileId: p.id,
      rank,
      kind: body?.kind ?? "link",
      label: body?.label ?? "Untitled",
      target: body?.target,
      icon: body?.icon,
      hidden: body?.hidden ?? false,
      activeFrom: body?.activeFrom,
      activeUntil: body?.activeUntil,
      rules: body?.rules ?? [],
      feed: body?.feed,
      ...(body?.kind === "feed" ? { items: [] } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    p.blocks.push(block);
    return envelope(p, block, 201);
  }],

  ["PATCH", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)$/, (req, body, [id, blockId]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const block = p.blocks.find((b) => b.id === blockId);
    if (!block) return notFound("block not found");
    // Validated against what the block will become, not against the patch
    // alone — the real one does the same, so a PATCH cannot clear a target.
    const shape = checkBlockShape({ ...block, ...body });
    if (shape) return shape;

    const stale = gate(req, p);
    if (stale) return stale;
    Object.assign(block, body, { updatedAt: Date.now() });
    return envelope(p, block);
  }],

  ["PUT", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)\/rules$/, (req, body, [id, blockId]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const block = p.blocks.find((b) => b.id === blockId);
    if (!block) return notFound("block not found");
    const invalid = checkRuleSet(body);
    if (invalid) return invalid;

    const stale = gate(req, p);
    if (stale) return stale;
    // The whole set, replaced. There is nothing smaller to send.
    block.rules = body;
    block.updatedAt = Date.now();
    return envelope(p, block);
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)\/move$/, (req, body, [id, blockId]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const block = p.blocks.find((b) => b.id === blockId);
    if (!block) return notFound("block not found");
    if (!body?.beforeId && !body?.afterId) return badRequest("provide beforeId or afterId");

    const stale = gate(req, p);
    if (stale) return stale;
    const others = [...p.blocks].filter((b) => b.id !== blockId).sort((a, b) => (a.rank < b.rank ? -1 : 1));
    if (body.afterId) {
      const i = others.findIndex((b) => b.id === body.afterId);
      if (i === -1) return badRequest("afterId refers to an unknown block");
      block.rank = rankBetween(others[i].rank, others[i + 1]?.rank ?? null);
    } else {
      const i = others.findIndex((b) => b.id === body.beforeId);
      if (i === -1) return badRequest("beforeId refers to an unknown block");
      block.rank = rankBetween(others[i - 1]?.rank ?? null, others[i].rank);
    }
    block.updatedAt = Date.now();
    return envelope(p, block);
  }],

  ["DELETE", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)$/, (req, _body, [id, blockId]) => {
    const owned = own(req, id);
    if (owned.error) return owned.error;
    const p = owned.profile;
    const stale = gate(req, p);
    if (stale) return stale;
    p.blocks = p.blocks.filter((b) => b.id !== blockId);
    // 204, with nothing in it. A client that reads an empty body as failure
    // will roll back a delete that actually happened.
    return { status: 204, body: null };
  }],

  ["POST", /^\/v1\/public\/([^/]+)\/resolve$/, (_req, body, [handle]) => {
    const p = byHandle(decodeURIComponent(handle));
    // An unpublished page is not a page, and saying "not found" is the only
    // answer that does not leak which handles are held by a draft.
    if (!p || p.publishedVersion === null) return notFound("no such page");
    return { status: 200, body: resolve(p, body ?? {}, { trace: false, draft: false }) };
  }],

  ["POST", /^\/v1\/events$/, (_req, body) => {
    const events = body?.events ?? [];
    state.events.push(...events);
    for (const e of events) console.log(`  event   ${e.handle}/${e.blockId ?? "-"} rule=${e.ruleId ?? "-"}`);
    return { status: 202, body: null };
  }],

  ["GET", /^\/health$/, () => ({ status: 200, body: { ok: true, ts: Date.now() } })],
];

function claimHandle(req, body, id) {
  const owned = own(req, id);
  if (owned.error) return owned.error;
  const p = owned.profile;
  const handle = String(body?.handle ?? "").toLowerCase();
  if (!HANDLE.test(handle) || RESERVED.has(handle)) return badRequest("validation failed");
  if (handle === p.handle) return envelope(p, publicProfile(p));
  if (handleState(handle, p.id).status !== "free") return conflict("handle already claimed");

  const stale = gate(req, p);
  if (stale) return stale;
  // The old handle is held against this profile, so links already printed
  // do not land on a stranger's page.
  state.tombstones.set(p.handle, { profileId: p.id, until: Date.now() + 90 * 864e5 });
  state.tombstones.delete(handle);
  p.handle = handle;
  return envelope(p, publicProfile(p));
}

function own(req, id) {
  const userId = authed(req);
  if (!userId) return { error: unauthorized() };
  const p = profile(id);
  if (!p) return { error: notFound("profile not found") };
  if (p.userId !== userId) return { error: forbidden() };
  return { profile: p };
}

/** `checkBlockShape`, restated: applied to the merged block on both create and patch. */
function checkBlockShape(b) {
  const issues = [];
  if (b.kind === "link" && !b.target) issues.push({ path: "target", message: "link blocks need a target" });
  if (b.kind === "feed" && !b.feed) issues.push({ path: "feed", message: "feed blocks need a feed config" });
  if (b.activeFrom && b.activeUntil && b.activeUntil <= b.activeFrom) {
    issues.push({ path: "activeUntil", message: "activeUntil must follow activeFrom" });
  }
  return issues.length ? badRequest("invalid block", issues) : null;
}

const DIMS = new Set(["geo", "device", "referrer", "lang", "webview", "time"]);

function checkRuleSet(rules) {
  if (!Array.isArray(rules)) return badRequest("validation failed", [{ path: "", message: "expected an array" }]);
  if (rules.length > MAX_RULES) return badRequest(`at most ${MAX_RULES} rules`);
  const issues = [];
  const ids = new Set();
  rules.forEach((r, i) => {
    if (!r?.id) issues.push({ path: `${i}.id`, message: "required" });
    if (ids.has(r?.id)) issues.push({ path: `${i}.id`, message: "duplicate rule id" });
    ids.add(r?.id);
    if (!Array.isArray(r?.when) || r.when.length === 0) {
      issues.push({ path: `${i}.when`, message: "at least one condition" });
    }
    const dims = new Set();
    (r?.when ?? []).forEach((c, j) => {
      if (!DIMS.has(c?.dim)) issues.push({ path: `${i}.when.${j}.dim`, message: "unknown dimension" });
      if (c?.dim !== "time" && dims.has(c?.dim)) {
        issues.push({ path: `${i}.when.${j}`, message: `duplicate ${c.dim} condition` });
      }
      dims.add(c?.dim);
      if (c?.dim === "time" && Array.isArray(c.days) && c.days.length === 0) {
        issues.push({ path: `${i}.when.${j}.days`, message: "omit days rather than sending an empty array" });
      }
    });
    if (r?.then?.kind !== "hide" && r?.then?.kind !== "redirect") {
      issues.push({ path: `${i}.then.kind`, message: "expected hide or redirect" });
    }
    if (r?.then?.kind === "redirect") {
      if (!r.then.target) issues.push({ path: `${i}.then.target`, message: "required" });
      if (r.then.status !== 302 && r.then.status !== 307) {
        issues.push({ path: `${i}.then.status`, message: "expected 302 or 307" });
      }
    }
  });
  return issues.length ? badRequest("validation failed", issues) : null;
}

/* ---------------------------------------------------------------- server --- */

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, if-match",
        "access-control-max-age": "86400",
      });
      return res.end();
    }

    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }

    const cors = {
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-expose-headers": "etag, x-request-id",
    };

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(path);
      if (!match) continue;

      const result = handler(req, body, match.slice(1));
      const label = result.status >= 400 ? `!! ${result.status}` : `   ${result.status}`;
      console.log(`${label}  ${req.method} ${path}${result.problem ? `  ${result.problem.title}` : ""}`);

      if (result.problem) {
        res.writeHead(result.status, { "content-type": "application/problem+json", ...cors });
        return res.end(JSON.stringify(result.problem));
      }
      if (result.body === null || result.body === undefined) {
        res.writeHead(result.status, cors);
        return res.end();
      }
      res.writeHead(result.status, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify(result.body));
    }

    console.log(`!! 404  ${req.method} ${path}`);
    res.writeHead(404, { "content-type": "application/problem+json", ...cors });
    res.end(JSON.stringify(notFound("no such route").problem));
  });
}).listen(PORT, () => {
  console.log(`mock api      http://localhost:${PORT}`);
  console.log(`profile       p_1 (/giorgi), version ${state.profiles[0].version}, published`);
  console.log(`sign in with  you@studio.com and any password\n`);
});
