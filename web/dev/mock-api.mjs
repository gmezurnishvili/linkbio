/**
 * Mock backend. Node only, no dependencies, no AWS.
 *
 *   node dev/mock-api.mjs        # listens on 8787
 *
 * Two jobs. It lets the frontend run before the real endpoints land, and it
 * doubles as an executable spec for the parts of the contract that aren't in
 * the Hono server yet: the write envelope, If-Match handling, and the two
 * resolution endpoints.
 *
 * The rule evaluation here is a stand-in, not a port. In particular sMaxAge is
 * found by scanning forward a minute at a time until the decision changes,
 * where the real evaluator computes the boundary directly, and there is no
 * DST gap or ambiguity detection at all. Anywhere the two disagree, the real
 * one is right.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);

/* ---------------------------------------------------------------- state --- */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const state = {
  user: { userId: "u_1", email: "you@studio.com" },
  accounts: new Map([["you@studio.com", "u_1"]]),
  profiles: [
    {
      id: "p_1",
      ownerId: "u_1",
      handle: "giorgi",
      displayName: "Giorgi",
      bio: "Producer. Tbilisi.",
      avatarUrl: null,
      mode: "standard",
      eventAt: null,
      theme: { preset: "paper", accent: "#1b4fd8", typeface: "grotesque", cornerStyle: "soft" },
      version: 12,
      publishedVersion: 12,
      publishedAt: new Date(Date.now() - 864e5).toISOString(),
      blocks: [
        {
          id: "b_tour",
          kind: "feed",
          label: "Tour dates",
          ruleIds: ["r_na"],
          rank: "a0",
          hidden: false,
          banditEnabled: false,
          banditPinned: false,
          source: {
            adapter: "bandsintown",
            refreshedAt: new Date(Date.now() - 24e4).toISOString(),
            itemCount: 3,
          },
          items: [
            { title: "Tbilisi — Mtkvarze", subtitle: "Oct 4", href: "https://example.com/t1" },
            { title: "Berlin — RSO", subtitle: "Oct 11", href: "https://example.com/t2" },
            { title: "London — Corsica", subtitle: "Oct 18", href: "https://example.com/t3" },
          ],
        },
        {
          id: "b_presave",
          kind: "link",
          label: "Presave — new single",
          url: "https://open.spotify.com/album/demo",
          slug: "presave",
          ruleIds: ["r_ios"],
          rank: "a5",
          hidden: false,
          banditEnabled: true,
          banditPinned: false,
        },
        {
          id: "b_rsvp",
          kind: "gate",
          label: "Afterparty RSVP",
          url: "https://example.com/rsvp",
          slug: "rsvp",
          ruleIds: ["r_late"],
          rank: "aG",
          hidden: false,
          banditEnabled: false,
          banditPinned: false,
          gate: { type: "email", prompt: "Leave an email to get the address" },
        },
        {
          id: "b_merch",
          kind: "link",
          label: "Merch",
          url: "https://shop.example.com",
          slug: "merch",
          ruleIds: [],
          rank: "aV",
          hidden: false,
          banditEnabled: false,
          banditPinned: false,
        },
      ],
      rules: [
        {
          id: "r_na",
          name: "Tour dates for North America only",
          conditions: [{ dimension: "country", op: "in", values: ["US", "CA"] }],
          effect: { type: "show" },
          priority: 10,
          enabled: true,
          warnings: [],
        },
        {
          id: "r_ios",
          name: "iOS visitors get Apple Music",
          conditions: [{ dimension: "os", op: "in", values: ["ios"] }],
          effect: { type: "rewrite", url: "https://music.apple.com/album/demo" },
          priority: 20,
          enabled: true,
          warnings: [],
        },
        {
          id: "r_late",
          name: "Late-night RSVP",
          conditions: [
            {
              dimension: "time",
              op: "within",
              // Crosses both midnight and, in November, the fall-back repeat —
              // useful for eyeballing what the real evaluator warns about.
              window: {
                timezone: "America/New_York",
                daysOfWeek: [5, 6],
                start: "22:00",
                end: "02:30",
              },
            },
          ],
          effect: { type: "show" },
          priority: 30,
          enabled: true,
          warnings: [
            {
              code: "dst-ambiguous",
              onDate: "2026-11-01",
              message:
                "On 2026-11-01, 01:00-02:00 happens twice in America/New_York. This window opens on the first pass.",
            },
          ],
        },
      ],
    },
  ],
  beacons: [],
};

function profile(id) {
  return state.profiles.find((p) => p.id === id);
}
function byHandle(handle) {
  return state.profiles.find((p) => p.handle === handle.toLowerCase());
}

/* ------------------------------------------------------------ evaluation --- */

/** Cache-key dimensions implied by the live rules. Mirrors the real mask. */
function cacheDimensions(p) {
  const out = new Set();
  for (const rule of p.rules) {
    if (!rule.enabled) continue;
    for (const c of rule.conditions) {
      if (c.dimension === "time") {
        if (c.window?.timezone === "viewer") out.add("tz-bucket");
        continue;
      }
      out.add(c.dimension);
    }
  }
  return [...out];
}

function localMinutes(timezone, instant) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (t) => parts.find((x) => x.type === t)?.value ?? "";
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = get("hour") === "24" ? 0 : Number(get("hour"));
  return { day: days[get("weekday")] ?? 0, minutes: hour * 60 + Number(get("minute")) };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function windowOpen(window, instant) {
  const zone = window.timezone === "viewer" ? "UTC" : window.timezone;
  const { day, minutes } = localMinutes(zone, instant);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const days = window.daysOfWeek;

  if (end > start) {
    return (days.length === 0 || days.includes(day)) && minutes >= start && minutes < end;
  }
  // Crosses midnight: the tail belongs to the previous day's window.
  const yesterday = (day + 6) % 7;
  if (minutes >= start) return days.length === 0 || days.includes(day);
  if (minutes < end) return days.length === 0 || days.includes(yesterday);
  return false;
}

function conditionHolds(condition, ctx) {
  if (condition.dimension === "time") {
    return windowOpen(condition.window, Date.parse(ctx.at));
  }
  const actual = ctx[condition.dimension === "referrer" ? "referrerHost" : condition.dimension];
  const values = condition.values ?? [];
  if (condition.op === "not-in") return !actual || !values.includes(actual);
  return Boolean(actual) && values.includes(actual);
}

function explain(condition, ctx) {
  if (condition.dimension === "time") {
    const w = condition.window;
    return `time ${windowOpen(w, Date.parse(ctx.at)) ? "within" : "outside"} ${w.start}-${w.end} ${w.timezone}`;
  }
  const key = condition.dimension === "referrer" ? "referrerHost" : condition.dimension;
  const actual = ctx[key] ?? "unset";
  const verb = condition.op === "not-in" ? "not in" : "in";
  return `${condition.dimension} ${actual} ${verb} [${(condition.values ?? []).join(", ")}]`;
}

/**
 * Seconds until the answer changes. Scanned rather than computed — the real
 * evaluator derives the boundary from the window edges directly, and memoises
 * by condition and UTC day.
 */
function secondsToBoundary(p, ctx) {
  const timeConditions = p.rules
    .filter((r) => r.enabled)
    .flatMap((r) => r.conditions)
    .filter((c) => c.dimension === "time");

  if (timeConditions.length === 0) return 3600;

  const now = Date.parse(ctx.at);
  const current = timeConditions.map((c) => windowOpen(c.window, now));

  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    const at = now + minute * 60_000;
    const next = timeConditions.map((c) => windowOpen(c.window, at));
    if (next.some((v, i) => v !== current[i])) {
      // Back off to the last second before the change so a cached copy never
      // outlives its decision.
      return minute * 60 - Math.floor((now % 60_000) / 1000);
    }
  }
  return 3600;
}

function resolve(p, ctx, { includeTrace }) {
  const trace = [];
  const dimensionsUsed = new Set();
  const blocks = [];

  for (const block of [...p.blocks].sort((a, b) => (a.rank < b.rank ? -1 : 1))) {
    if (block.hidden) continue;

    let visible = true;
    let href = block.url;

    for (const ruleId of block.ruleIds) {
      const rule = p.rules.find((r) => r.id === ruleId);
      if (!rule || !rule.enabled) continue;

      const results = rule.conditions.map((c) => conditionHolds(c, ctx));
      const matched = results.every(Boolean);

      for (const c of rule.conditions) {
        if (c.dimension === "time") {
          if (c.window?.timezone === "viewer") dimensionsUsed.add("tz-bucket");
        } else {
          dimensionsUsed.add(c.dimension);
        }
      }

      if (includeTrace) {
        const failing = rule.conditions.find((_, i) => !results[i]);
        trace.push({
          ruleId: rule.id,
          ruleName: rule.name,
          outcome: matched ? "match" : "skip",
          because: explain(failing ?? rule.conditions[0], ctx),
        });
      }

      if (!matched) {
        if (rule.effect.type === "show") visible = false;
        continue;
      }
      if (rule.effect.type === "hide") visible = false;
      if (rule.effect.type === "rewrite") href = rule.effect.url;
    }

    if (!visible) continue;

    blocks.push({
      id: block.id,
      kind: block.kind,
      label: block.label,
      href,
      slug: block.slug,
      gate: block.gate,
      items: block.items,
    });
  }

  return {
    profile: {
      handle: p.handle,
      displayName: p.displayName,
      bio: p.bio,
      avatarUrl: p.avatarUrl,
      mode: p.mode,
      eventAt: p.eventAt,
      theme: p.theme,
    },
    blocks,
    sMaxAge: secondsToBoundary(p, ctx),
    varyOn: [...dimensionsUsed],
    trace,
    warnings: p.rules.filter((r) => r.enabled).flatMap((r) => r.warnings ?? []),
  };
}

/* ----------------------------------------------------------------- ranks --- */

function rankBetween(after, before) {
  const lo = after ? DIGITS.indexOf(after[0]) : 0;
  const hi = before ? DIGITS.indexOf(before[0]) : DIGITS.length - 1;
  if (hi - lo > 1) return DIGITS[Math.floor((lo + hi) / 2)];
  // No room at this position. Real backend would rebalance; appending a
  // midpoint is enough to keep the dev list sorted.
  return `${after ?? DIGITS[lo]}${DIGITS[Math.floor(DIGITS.length / 2)]}`;
}

/* --------------------------------------------------------------- routing --- */

function bump(p) {
  p.version += 1;
  return { version: p.version, cacheDimensions: cacheDimensions(p) };
}

/** Writes must carry If-Match, the way the real backend requires. */
function stale(req, p) {
  const ifMatch = req.headers["if-match"];
  if (ifMatch === undefined) return false;
  return Number(ifMatch) !== p.version;
}

const routes = [
  ["POST", /^\/v1\/auth\/token$/, () => ({
    status: 200,
    body: { accessToken: `dev.${randomUUID()}`, refreshToken: `devr.${randomUUID()}`, expiresIn: 900 },
  })],

  ["POST", /^\/v1\/auth\/register$/, (_req, body) => {
    const email = String(body?.email ?? "").toLowerCase();
    if (state.accounts.has(email)) {
      return { status: 409, body: { message: "Email already registered" } };
    }
    const userId = `u_${randomUUID().slice(0, 6)}`;
    state.accounts.set(email, userId);
    // One signed-in identity at a time is enough to walk the flow. Profiles
    // stay put and are filtered by owner, so an existing handle is still taken
    // for the new account.
    state.user = { userId, email };
    return {
      status: 200,
      body: {
        accessToken: `dev.${randomUUID()}`,
        refreshToken: `devr.${randomUUID()}`,
        expiresIn: 900,
      },
    };
  }],

  ["POST", /^\/v1\/auth\/refresh$/, () => ({
    status: 200,
    body: { accessToken: `dev.${randomUUID()}`, expiresIn: 900 },
  })],

  ["GET", /^\/v1\/me$/, () => ({
    status: 200,
    body: {
      ...state.user,
      profiles: state.profiles
        .filter((p) => p.ownerId === state.user.userId)
        .map((p) => ({
          id: p.id,
          handle: p.handle,
          displayName: p.displayName,
        })),
    },
  })],

  ["POST", /^\/v1\/profiles$/, (_req, body) => {
    const handle = String(body?.handle ?? "").toLowerCase();
    if (byHandle(handle)) {
      return { status: 409, body: { message: "Handle already claimed" } };
    }
    const p = {
      id: `p_${randomUUID().slice(0, 6)}`,
      ownerId: state.user.userId,
      handle,
      displayName: body?.displayName || handle,
      bio: "",
      avatarUrl: null,
      mode: "standard",
      eventAt: null,
      theme: { preset: "paper", accent: "#1b4fd8", typeface: "grotesque", cornerStyle: "soft" },
      version: 1,
      publishedVersion: null,
      publishedAt: null,
      blocks: [],
      rules: [],
    };
    state.profiles.push(p);
    return { status: 200, body: { ...p, cacheDimensions: [] } };
  }],

  ["GET", /^\/v1\/profiles\/([^/]+)$/, (_req, _body, [id]) => {
    const p = profile(id);
    if (!p) return { status: 404, body: { message: "No such profile" } };
    return { status: 200, body: { ...p, cacheDimensions: cacheDimensions(p) } };
  }],

  ["PATCH", /^\/v1\/profiles\/([^/]+)$/, (req, body, [id]) => {
    const p = profile(id);
    if (!p) return { status: 404, body: { message: "No such profile" } };
    if (stale(req, p)) return conflict(p);
    if (body.theme) Object.assign(p.theme, body.theme);
    for (const [k, v] of Object.entries(body)) if (k !== "theme") p[k] = v;
    return { status: 200, body: { data: { ...p, cacheDimensions: cacheDimensions(p) }, ...bump(p) } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/publish$/, (req, _body, [id]) => {
    const p = profile(id);
    if (!p) return { status: 404, body: { message: "No such profile" } };
    if (stale(req, p)) return conflict(p);
    p.publishedVersion = p.version;
    p.publishedAt = new Date().toISOString();
    return {
      status: 200,
      body: { data: { ...p, cacheDimensions: cacheDimensions(p) }, version: p.version, cacheDimensions: cacheDimensions(p) },
    };
  }],

  ["GET", /^\/v1\/handles\/([^/]+)$/, (_req, _body, [handle]) => {
    if (byHandle(handle)) return { status: 200, body: { available: false, reason: "taken" } };
    if (handle === "tombstoned") return { status: 200, body: { available: false, reason: "tombstoned" } };
    return { status: 200, body: { available: true } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/handle$/, (req, body, [id]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    p.handle = String(body.handle).toLowerCase();
    return { status: 200, body: { data: { ...p, cacheDimensions: cacheDimensions(p) }, ...bump(p) } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/blocks$/, (req, body, [id]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    const last = [...p.blocks].sort((a, b) => (a.rank < b.rank ? -1 : 1)).at(-1);
    const block = {
      id: `b_${randomUUID().slice(0, 8)}`,
      kind: body.kind ?? "link",
      label: body.label ?? "Untitled",
      url: body.url,
      slug: body.slug,
      ruleIds: [],
      rank: rankBetween(last?.rank ?? null, null),
      hidden: false,
      banditEnabled: false,
      banditPinned: false,
      ...(body.kind === "gate" ? { gate: { type: "email", prompt: "Leave an email" } } : {}),
      ...(body.kind === "feed" ? { source: { adapter: "manual", itemCount: 0 }, items: [] } : {}),
    };
    p.blocks.push(block);
    return { status: 200, body: { data: block, ...bump(p) } };
  }],

  ["PATCH", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)$/, (req, body, [id, blockId]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    const block = p.blocks.find((b) => b.id === blockId);
    if (!block) return { status: 404, body: { message: "No such block" } };
    Object.assign(block, body);
    return { status: 200, body: { data: block, ...bump(p) } };
  }],

  ["DELETE", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)$/, (req, _body, [id, blockId]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    p.blocks = p.blocks.filter((b) => b.id !== blockId);
    return { status: 200, body: { data: { id: blockId }, ...bump(p) } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/blocks\/([^/]+)\/move$/, (req, body, [id, blockId]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    const block = p.blocks.find((b) => b.id === blockId);
    if (!block) return { status: 404, body: { message: "No such block" } };
    const after = body.afterId ? p.blocks.find((b) => b.id === body.afterId) : null;
    const before = body.beforeId ? p.blocks.find((b) => b.id === body.beforeId) : null;
    block.rank = rankBetween(after?.rank ?? null, before?.rank ?? null);
    const { version } = bump(p);
    return { status: 200, body: { blockId, rank: block.rank, version } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/rules$/, (req, body, [id]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    const rule = { id: `r_${randomUUID().slice(0, 8)}`, warnings: [], ...body };
    p.rules.push(rule);
    return { status: 200, body: { data: rule, ...bump(p) } };
  }],

  ["PATCH", /^\/v1\/profiles\/([^/]+)\/rules\/([^/]+)$/, (req, body, [id, ruleId]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    const rule = p.rules.find((r) => r.id === ruleId);
    if (!rule) return { status: 404, body: { message: "No such rule" } };
    Object.assign(rule, body);
    return { status: 200, body: { data: rule, ...bump(p) } };
  }],

  ["DELETE", /^\/v1\/profiles\/([^/]+)\/rules\/([^/]+)$/, (req, _body, [id, ruleId]) => {
    const p = profile(id);
    if (stale(req, p)) return conflict(p);
    p.rules = p.rules.filter((r) => r.id !== ruleId);
    for (const b of p.blocks) b.ruleIds = b.ruleIds.filter((r) => r !== ruleId);
    return { status: 200, body: { data: { id: ruleId }, ...bump(p) } };
  }],

  ["POST", /^\/v1\/profiles\/([^/]+)\/preview$/, (_req, body, [id]) => {
    const p = profile(id);
    if (!p) return { status: 404, body: { message: "No such profile" } };
    return { status: 200, body: resolve(p, normalise(body), { includeTrace: true }) };
  }],

  ["POST", /^\/v1\/public\/([^/]+)\/resolve$/, (_req, body, [handle]) => {
    const p = byHandle(handle);
    if (!p) return { status: 404, body: { message: "No such handle" } };
    return { status: 200, body: resolve(p, normalise(body), { includeTrace: false }) };
  }],

  ["POST", /^\/v1\/beacon$/, (_req, body) => {
    state.beacons.push({ ...body, receivedAt: Date.now() });
    console.log(`  beacon  ${body.h}/${body.b}  variant=${body.v ?? "-"}`);
    return { status: 204, body: null };
  }],
];

function conflict(p) {
  return {
    status: 409,
    body: { message: `Version conflict. Current version is ${p.version}.` },
  };
}

function normalise(body) {
  return { ...body, at: body?.at ?? new Date().toISOString() };
}

/* ---------------------------------------------------------------- server --- */

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;

    // The beacon is the one endpoint the browser hits directly, via sendBeacon
    // with a text/plain body. No preflight, no Authorization — just accept it.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
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

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(path);
      if (!match) continue;

      const result = handler(req, body, match.slice(1));
      const label = result.status >= 400 ? `!! ${result.status}` : `   ${result.status}`;
      console.log(`${label}  ${req.method} ${path}`);

      if (result.body === null) {
        res.writeHead(result.status, { "access-control-allow-origin": "*" });
        return res.end();
      }
      res.writeHead(result.status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      return res.end(JSON.stringify(result.body));
    }

    console.log(`!! 404  ${req.method} ${path}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "No such route" }));
  });
}).listen(PORT, () => {
  console.log(`mock api      http://localhost:${PORT}`);
  console.log(`profile       p_1 (/giorgi), version ${state.profiles[0].version}`);
  console.log(`sign in with  any email and password\n`);
});
