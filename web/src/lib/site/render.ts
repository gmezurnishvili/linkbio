import type { CacheDimension, Resolution, ResolvedBlock } from "@/lib/api/types";
import { BASE_CSS, themeVariables } from "./theme";
import { runtimeScript } from "./runtime";
import { safeHref, safeUrl } from "./url";

/**
 * The public profile is rendered to an HTML string rather than through React.
 *
 * Two reasons, both structural:
 *
 *   - Cache-Control has to carry the evaluator's exact next-boundary value, and
 *     that is a per-request number. A Next.js page cannot set a response header;
 *     a route handler can. Rendering here means the TTL and the HTML are
 *     produced by the same code path and can never disagree.
 *   - This page is in the LCP path for every visitor a creator ever gets. There
 *     is no interactive state on it, so a client framework would be paying
 *     hydration cost for three event listeners. The whole runtime is inline and
 *     under 2KB.
 *
 * The dashboard is a normal React app; nothing here is a house style.
 */

export interface RenderOptions {
  resolution: Resolution;
  origin: string;
  beaconUrl: string;
  /** Opaque cache-key fingerprint, echoed back on beacons to attribute variants. */
  variant?: string;
  /** True when rendering inside the dashboard's simulator iframe. */
  preview?: boolean;
}

export interface ProfileDocument {
  html: string;
  /** Exactly what sits between <style> and </style>. */
  style: string;
  /** Exactly what sits between <script> and </script>. */
  script: string;
}

/**
 * The page, plus the two inline blocks it embedded, byte for byte.
 *
 * The caller hashes those two strings into the CSP. Handing them back rather
 * than letting the caller rebuild them is the whole point: a hash computed from
 * a second, hopefully-identical copy of the CSS would silently stop matching
 * the moment a theme variable changed, and the page would ship with its own
 * styles blocked.
 */
export function renderProfileDocument(opts: RenderOptions): ProfileDocument {
  const { resolution, origin, beaconUrl, variant, preview } = opts;
  const p = resolution.profile;
  const canonical = `${origin}/${p.handle}`;
  const title = p.displayName || p.handle;
  const image = safeUrl(p.avatarUrl);

  const style = `:root{${themeVariables(p.theme)}}${BASE_CSS}`;
  const script = runtimeScript(beaconUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.bio)}">
<link rel="canonical" href="${esc(safeHref(canonical))}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(p.bio)}">
<meta property="og:url" content="${esc(safeHref(canonical))}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
<meta name="twitter:card" content="summary">
${preview ? `<meta name="robots" content="noindex">` : ""}
<style>${style}</style>
<script type="application/ld+json">${jsonLd(opts)}</script>
<link rel="alternate" type="application/ld+json" href="${esc(safeHref(`${canonical}/identity.json`))}">
</head>
<body data-handle="${esc(p.handle)}"${variant ? ` data-variant="${esc(variant)}"` : ""}${preview ? ` data-preview="1"` : ""}>
<main>
<div id="escape" role="status">
  <span>You're in an in-app browser. Some links won't work here.</span>
  <button type="button">Open in <span data-browser>your browser</span></button>
</div>
${header(opts)}
${countdown(opts)}
<div class="stack">
${resolution.blocks.map((b) => block(b, p.handle)).join("\n")}
</div>
${resolution.blocks.length === 0 ? `<p class="note">Nothing here yet.</p>` : ""}
<p class="foot">${esc(p.handle)}</p>
</main>
<script>${script}</script>
</body>
</html>`;

  return { html, style, script };
}

/** The page on its own, for callers with no CSP to build (the simulator). */
export function renderProfile(opts: RenderOptions): string {
  return renderProfileDocument(opts).html;
}

function header({ resolution }: RenderOptions): string {
  const p = resolution.profile;
  const image = safeUrl(p.avatarUrl);
  const avatar = image
    ? `<img class="avatar" src="${esc(image)}" alt="" width="56" height="56" decoding="async">`
    : `<div class="avatar" aria-hidden="true"></div>`;
  return `<div class="head">
  ${avatar}
  <div>
    <h1 class="name">${esc(p.displayName || p.handle)}</h1>
    <p class="handle">${esc(p.handle)}</p>
  </div>
</div>
${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ""}`;
}

function countdown({ resolution }: RenderOptions): string {
  const p = resolution.profile;
  if (p.mode === "standard" || !p.eventAt) return "";
  const noun = p.mode === "drop" ? "until it drops" : "until doors";
  // The duration is computed in the browser from this instant, not rendered
  // here — the HTML is cached and a pre-rendered "4h 12m" would age badly.
  return `<div class="countdown" id="countdown" data-at="${esc(p.eventAt)}">
  <b>—</b><span>${noun}</span>
</div>`;
}

function block(b: ResolvedBlock, handle: string): string {
  switch (b.kind) {
    case "feed":
      return feedBlock(b);
    case "text":
      return `<p class="note">${esc(b.label)}</p>`;
    case "gate":
      return `<a class="block" href="${esc(safeHref(b.href ?? `/${handle}/l/${b.slug ?? b.id}`))}"
  data-block="${esc(b.id)}"${b.slug ? ` data-slug="${esc(b.slug)}"` : ""}>
  <span class="tick" aria-hidden="true"></span>
  <span class="block-label">${esc(b.label)}${
    b.gate ? `<span class="gate-prompt">${esc(b.gate.prompt)}</span>` : ""
  }</span>
</a>`;
    case "link":
    case "embed":
    default:
      return linkBlock(b, handle);
  }
}

function linkBlock(b: ResolvedBlock, handle: string): string {
  const href = b.href ?? `/${handle}/l/${b.slug ?? b.id}`;
  return `<a class="block" href="${esc(safeHref(href))}"
  data-block="${esc(b.id)}"${b.slug ? ` data-slug="${esc(b.slug)}"` : ""}>
  <span class="block-label">${esc(b.label)}</span>
  <span class="block-meta">${esc(destinationHint(b.target))}</span>
</a>`;
}

function feedBlock(b: ResolvedBlock): string {
  const items = (b.items ?? []).slice(0, 4);
  if (items.length === 0) return "";
  return `<div class="block feed" data-block="${esc(b.id)}">
  <p class="feed-title">${esc(b.label)}</p>
  ${items
    .map((it) => {
      const row = `<span>${esc(it.title)}</span>${
        it.subtitle ? `<em>${esc(it.subtitle)}</em>` : ""
      }`;
      return it.href
        ? `<a class="feed-item" href="${esc(safeHref(it.href))}" data-block="${esc(b.id)}">${row}</a>`
        : `<div class="feed-item">${row}</div>`;
    })
    .join("\n  ")}
</div>`;
}

/**
 * Visitors get told where a link actually goes. It is a courtesy on a page full
 * of opaque short links, and on a page whose destinations change by context it
 * is also the honest thing to show.
 *
 * It reads `target`, not `href`. `href` is the redirector — `/r/:handle/:id` —
 * which `new URL()` rejects outright, so every hint on every page came back
 * empty through the catch below and the line rendered blank.
 */
function destinationHint(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Agent-readable identity. The same document is served standalone at
 * /:handle/identity.json for clients that would rather not parse HTML.
 */
export function jsonLd({ resolution, origin }: RenderOptions): string {
  const p = resolution.profile;
  const doc = {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": safeUrl(`${origin}/${p.handle}#identity`),
    name: p.displayName || p.handle,
    alternateName: p.handle,
    description: p.bio || undefined,
    image: safeUrl(p.avatarUrl),
    url: safeUrl(`${origin}/${p.handle}`),
    // An agent reading this document will follow what it finds here, so the
    // same scheme rule applies as in the markup. A rejected URL is dropped
    // rather than replaced: "#" would be worse than saying nothing.
    sameAs: resolution.blocks
      .filter((b) => b.kind === "link")
      .map((b) => safeUrl(b.href))
      .filter((href): href is string => href !== undefined)
      .slice(0, 25),
    subjectOf: resolution.blocks
      .filter((b) => b.kind === "feed" && b.items?.length)
      .flatMap((b) =>
        (b.items ?? []).slice(0, 10).map((it) => ({
          "@type": "Event",
          name: it.title,
          description: it.subtitle || undefined,
          url: safeUrl(it.href),
        })),
      ),
  };
  // JSON inside a <script> block: only "<" needs neutralising to keep a value
  // like "</script>" from ending the element early.
  return JSON.stringify(doc, dropEmpty).replace(/</g, "\\u003c");
}

function dropEmpty(_key: string, value: unknown) {
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

/**
 * Which request headers a resolution's dimensions correspond to.
 *
 * `null` is a dimension that genuinely varies nothing the viewer sent, and is
 * spelled out so it is skipped on purpose rather than by omission. Absent is an
 * unknown dimension, which varyHeader refuses to guess at.
 */
const VIEWER_HEADER: Record<string, string | null> = {
  // The backend's vocabulary — `cacheDimensionsFor` in api/src/publish.ts. Geo
  // reaches the origin as a country and is bucketed at the edge, so the header
  // that varies is still the country one.
  geo: "CloudFront-Viewer-Country",
  device: "CloudFront-Is-Mobile-Viewer, CloudFront-Is-Tablet-Viewer",
  referrer: "Referer",
  lang: "Accept-Language",
  webview: "User-Agent",
  // A time window bounds the TTL instead of splitting the key: two visitors at
  // the same instant get the same page, and s-maxage is what expires it.
  time: null,

  // The display-side estimate's older names, which still reach here from a
  // profile whose mask was computed before the backend owned it.
  country: "CloudFront-Viewer-Country",
  region: "CloudFront-Viewer-Country-Region",
  os: "User-Agent",
  language: "Accept-Language",
  "tz-bucket": null,
};

export function varyHeader(dimensions: CacheDimension[]): string | null {
  // CloudFront builds the real cache key from the KeyValueStore mask; this
  // header is for any intermediary between the viewer and the distribution,
  // and for humans reading curl output.
  const names = new Set<string>();
  for (const d of dimensions) {
    const header = VIEWER_HEADER[d];
    if (header === null) continue;
    if (header === undefined) {
      // The old `.filter(Boolean)` swallowed exactly this case, and geo, lang
      // and webview — every dimension the backend actually reports — vanished
      // from the header without a single sign of it. A dimension we cannot
      // express is a page that varies on something a shared cache cannot see,
      // so say so and take the hit: a cold cache is visible, one visitor's page
      // served to another is not.
      console.warn(`varyHeader: no viewer header known for cache dimension "${d}"`);
      return "*";
    }
    names.add(header);
  }
  return names.size ? [...names].join(", ") : null;
}

export function esc(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
