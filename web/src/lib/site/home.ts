import { RESERVED_HANDLES } from "@/lib/handles";
import { safeHref } from "./url";

/**
 * The homepage.
 *
 * `/` had no route at all, so the root of the site answered 404 while every
 * handle under it worked. This fills it, and it is built the way the public
 * profile is built rather than the way the dashboard is:
 *
 *   - **A rendered string, not a React page.** Same two reasons as
 *     `render.ts`. The response needs its own `Cache-Control`, which a page
 *     component cannot set, and this document is in the LCP path of every
 *     first-time visitor the product ever gets. There is no server state on
 *     it, so a framework would be paying hydration cost for six event
 *     listeners.
 *   - **No webfont.** `app/layout.tsx` loads Instrument Sans and IBM Plex
 *     Mono, which is right for the dashboard and wrong here for exactly the
 *     reason that layout's own comment gives: a visitor-facing page should not
 *     carry one. The system stacks below are the same shapes at a distance.
 *   - **Two inline blocks, handed back to the caller.** `app/route.ts` hashes
 *     them into the CSP. Returning the bytes rather than letting the caller
 *     rebuild them is what makes the hash unable to drift from what shipped.
 *
 * It is also not under `app/layout.tsx`, which sets `robots: noindex` on
 * everything it wraps — a route handler renders its own document, so this page
 * is indexable and the dashboard stays hidden.
 *
 * ## What the page argues
 *
 * That the product is demonstrable in one frame. It reads the visitor's own
 * context, resolves a sample creator's page against it, and shows the rules
 * that fired, the cache key and the lifetime. Every dial can be moved, and the
 * page re-resolves.
 *
 * The context read happens **in the browser**, which is the one place this
 * page departs from the real thing, and it says so on screen rather than
 * implying otherwise. The reason is caching: `/` falls on the distribution's
 * default behaviour, `edge/page.js` writes no `x-ctx` for a path with no
 * handle, and so this document is one cache entry served to everyone. Varying
 * it server-side would mean giving the homepage its own mask and fragmenting
 * that entry six ways for a page with nothing personal on it. The demo rules
 * below are evaluated client-side for the same reason.
 *
 * What is *not* faked: the dimensions, the buckets, the two actions a rule can
 * take, the shape of the cache key, and the handle rules on the claim field.
 * Those all come from the real vocabulary, and where they are restated here
 * there is a test that fails when the two copies disagree.
 */

export interface HomeDocument {
  html: string;
  /** Exactly what sits between <style> and </style>. */
  style: string;
  /** Exactly what sits between <script> and </script>. */
  script: string;
}

export interface HomeOptions {
  /** The origin the visitor actually reached, for the canonical URL and OG. */
  origin: string;
}

/** The demo creator's timezone. A time window is meaningless without one. */
export const DEMO_TZ = "Europe/Berlin";

/**
 * The handle validator the claim field runs, as source text.
 *
 * Exported so `home.test.ts` can evaluate these exact bytes and compare them,
 * input by input, against `handleProblem` in `lib/handles.ts`. A second copy of
 * a rule is only safe when something fails the moment the two disagree — and
 * this one is the copy a visitor meets first, so a claim the form accepts and
 * the backend refuses is the worst version of that failure.
 *
 * Empty input is deliberately not handled here: the field shows nothing until
 * something is typed, which is the caller's decision, not the rule's.
 */
export const HANDLE_VALIDATOR_SOURCE = `function problem(raw, RESERVED) {
  var value = String(raw).trim().toLowerCase();
  if (value.length < 2) return "Two characters at least.";
  if (value.length > 30) return "Thirty characters at most.";
  if (RESERVED.indexOf(value) >= 0) return "This one is reserved.";
  if (!/^[a-z0-9]/.test(value)) return "Start with a letter or a number.";
  if (!/[a-z0-9]$/.test(value)) return "End with a letter or a number.";
  if (/[_-]{2}/.test(value)) return "No two dashes or underscores in a row.";
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(value)) {
    return "Lowercase letters, numbers, dashes and underscores only.";
  }
  return null;
}`;

/**
 * The design system is the dashboard's, restated for a page that ships no
 * stylesheet: cool paper, hairlines instead of cards, tabular numerals, and
 * colour used only to name a context dimension. Geo blue, device violet,
 * source green, language plum, clock amber, webview slate — the same six
 * everywhere in the product, so a chip here and a block rail in the editor
 * mean the same thing.
 *
 * Everything inside `.screen` uses literal colours rather than tokens. That
 * region is a picture of a creator's page in *their* theme; it does not follow
 * the visitor's dark mode, and a token there would repaint a light phone with
 * dark-mode values.
 */
const STYLE = `
:root{
--paper:#f4f5f7;--panel:#fff;--sunk:#eceef1;--ink:#141a22;--muted:#6b7480;
--faint:#9aa3ad;--line:#dfe2e7;--line-strong:#c4c9d1;
--geo:#1b4fd8;--geo-wash:#e8edfb;--device:#5b3fc4;--device-wash:#eeeafa;
--ref:#0f6e56;--ref-wash:#e4f3ee;--lang:#9e2a5b;--lang-wash:#fbe9f0;
--clock:#9c5a00;--clock-wash:#fbf0dd;--wv:#3f5566;--wv-wash:#e9eef1;
--alert:#a8201c;--bezel:#d4d8de;
--shadow:0 1px 2px rgba(20,26,34,.05),0 12px 32px -18px rgba(20,26,34,.35);
--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,
 "Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{
--paper:#101317;--panel:#171b20;--sunk:#1d2229;--ink:#e9ecf0;--muted:#97a0ab;
--faint:#6d7783;--line:#272d35;--line-strong:#3a424c;
--geo:#8aa9ff;--geo-wash:#1a2340;--device:#b6a3f7;--device-wash:#241f3c;
--ref:#5cc3a3;--ref-wash:#123029;--lang:#f091b4;--lang-wash:#33182a;
--clock:#e3b168;--clock-wash:#34260f;--wv:#9fb4c4;--wv-wash:#1e262c;
--alert:#f08b86;--bezel:#2b323a;
--shadow:0 1px 2px rgba(0,0,0,.4),0 16px 40px -20px rgba(0,0,0,.8)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
 font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:68rem;margin:0 auto;padding-inline:20px}
.tnum{font-variant-numeric:tabular-nums}
a{color:inherit}
*:focus-visible{outline:2px solid var(--geo);outline-offset:2px;border-radius:3px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{
 transition-duration:.01ms !important;animation-duration:.01ms !important}}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:1rem;
 padding-block:1.125rem;border-bottom:1px solid var(--line)}
.mark{display:flex;align-items:center;gap:.5rem;font-weight:600;
 letter-spacing:-.02em;font-size:1.0625rem}
.mark svg{display:block;overflow:visible}
.mark .tail{stroke:var(--ref)}
.masthead nav{display:flex;align-items:center;gap:1.25rem;font-size:.875rem}
.masthead nav a{color:var(--muted);text-decoration:none}
.masthead nav a:hover{color:var(--ink)}
.masthead .signin{color:var(--ink);border:1px solid var(--line-strong);
 border-radius:8px;padding:.3125rem .75rem}
@media (max-width:640px){.masthead nav .hide-sm{display:none}}
.hero{padding-block:3.25rem 1.5rem}
.eyebrow{font-family:var(--mono);font-size:.75rem;letter-spacing:.06em;
 text-transform:uppercase;color:var(--muted);margin:0 0 1rem;display:flex;
 align-items:center;gap:.5rem}
.eyebrow::before{content:"";width:6px;height:6px;border-radius:999px;
 background:var(--ref);box-shadow:0 0 0 3px var(--ref-wash)}
h1{font-size:clamp(2.125rem,6.2vw,3.5rem);line-height:1.02;letter-spacing:-.035em;
 font-weight:600;margin:0;max-width:17ch;text-wrap:balance}
h1 em{font-style:italic;font-weight:500}
.lede{margin:1.125rem 0 0;font-size:1.0625rem;color:var(--muted);max-width:58ch}
.desk{margin-top:2.5rem;display:grid;grid-template-columns:minmax(0,1fr) 20.5rem;
 gap:1.75rem;align-items:start}
.deskcol{display:flex;flex-direction:column;gap:1.25rem;min-width:0}
@media (max-width:900px){.desk{grid-template-columns:minmax(0,1fr)}
 .desk>.deskcol{order:2}.desk>.stage{order:1}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;
 gap:.75rem;padding:.8125rem 1rem;border-bottom:1px solid var(--line)}
.panel-head h2{margin:0;font-size:.8125rem;font-weight:600;letter-spacing:.01em}
.panel-head .sub{font-family:var(--mono);font-size:.6875rem;color:var(--faint)}
.dials{padding:.25rem 0}
.dial{display:grid;grid-template-columns:7.25rem minmax(0,1fr);align-items:center;
 gap:.75rem;padding:.5rem 1rem;border-top:1px solid var(--line)}
.dial:first-child{border-top:0}
.dial-name{display:flex;align-items:center;gap:.5rem;font-size:.8125rem;
 color:var(--muted);min-width:0}
.dial-name .rail{width:3px;height:1.0625rem;border-radius:2px;flex:none;
 background:var(--dim)}
.dial-name b{font-weight:500;color:var(--ink);font-size:.8125rem}
.dial[data-active="1"] .dial-name b{color:var(--dim)}
.dial-control{display:flex;align-items:center;gap:.5rem;min-width:0}
select.pick,.toggle{font:inherit;font-size:.8125rem;color:var(--ink);
 background:var(--sunk);border:1px solid transparent;border-radius:7px;
 padding:.3125rem .5rem;width:100%;min-width:0}
select.pick:hover,.toggle:hover{border-color:var(--line-strong)}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:.5rem;
 cursor:pointer;text-align:left}
.toggle .state{font-family:var(--mono);font-size:.75rem;color:var(--muted)}
.toggle[aria-pressed="true"]{background:var(--wv-wash);color:var(--wv);
 border-color:var(--wv)}
.toggle[aria-pressed="true"] .state{color:var(--wv)}
.clockrow{display:flex;align-items:center;gap:.75rem;width:100%}
input[type=range]{-webkit-appearance:none;appearance:none;flex:1;min-width:0;
 height:22px;background:transparent;cursor:pointer;margin:0}
input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;
 background:var(--line-strong)}
input[type=range]::-moz-range-track{height:3px;border-radius:2px;
 background:var(--line-strong)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
 width:13px;height:13px;border-radius:999px;margin-top:-5px;background:var(--clock);
 border:2px solid var(--panel);box-shadow:0 0 0 1px var(--clock)}
input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:999px;
 background:var(--clock);border:2px solid var(--panel);box-shadow:0 0 0 1px var(--clock)}
.clockval{font-family:var(--mono);font-size:.8125rem;color:var(--clock);flex:none;
 width:4.25rem;text-align:right}
.readnote{padding:.75rem 1rem .875rem;border-top:1px solid var(--line);
 font-size:.75rem;color:var(--faint);display:flex;gap:.625rem;align-items:flex-start}
.readnote button{font:inherit;font-size:.75rem;color:var(--geo);background:none;
 border:0;padding:0;cursor:pointer;text-decoration:underline;flex:none}
.trace{font-family:var(--mono);font-size:.75rem;padding:.5rem 0}
.trace-line{display:grid;grid-template-columns:2.75rem minmax(0,1fr) auto;
 gap:.625rem;align-items:baseline;padding:.3125rem 1rem}
.trace-line .rid{color:var(--faint)}
.trace-line .what{color:var(--ink);overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap}
.trace-line .why{color:var(--dim);flex:none}
.trace-line.none{color:var(--faint);grid-template-columns:1fr}
.ledger{border-top:1px solid var(--line);padding:.625rem 1rem .75rem}
.ledger dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);
 gap:.25rem .875rem;font-family:var(--mono);font-size:.75rem}
.ledger dt{color:var(--faint)}
.ledger dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.ledger dd.key{color:var(--geo)}
.ledger dd.ttl{color:var(--ref)}
.stage{display:flex;flex-direction:column;gap:.625rem;align-items:center}
.phone{width:100%;max-width:20.5rem;border:1px solid var(--bezel);border-radius:22px;
 padding:9px;background:var(--panel);box-shadow:var(--shadow)}
.screen{border-radius:14px;overflow:hidden;background:#f7f6f3;color:#16161a;
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 height:30.5rem;display:flex;flex-direction:column}
.urlbar{display:flex;align-items:center;gap:.375rem;padding:.5rem .6875rem;
 background:#eeece7;border-bottom:1px solid #e2e0da;font-size:.6875rem;color:#6e6e73;
 font-family:var(--mono);flex:none}
.urlbar .lock{width:9px;height:9px;flex:none}
.urlbar b{color:#16161a;font-weight:500}
.screen-scroll{overflow-y:auto;overscroll-behavior:contain;
 padding:1.375rem 1.125rem 1.75rem;flex:1}
.pg-escape{display:flex;align-items:center;gap:.5rem;padding:.5rem .625rem;
 margin-bottom:1rem;border:1px solid #c9c6bd;border-radius:10px;background:#fff;
 font-size:.6875rem;line-height:1.35;color:#16161a}
.pg-escape .i{flex:none;color:#3f5566}
.pg-escape u{text-decoration:none;color:#b0652b;font-weight:600;white-space:nowrap}
.pg-head{display:flex;gap:.625rem;align-items:center;margin-bottom:.625rem}
.pg-avatar{width:42px;height:42px;border-radius:999px;flex:none;
 background:linear-gradient(145deg,#cfd9c7,#9db38c 55%,#c7a86a)}
.pg-name{font-size:1.0625rem;font-weight:600;letter-spacing:-.018em;margin:0;
 line-height:1.15}
.pg-handle{font-size:.6875rem;color:#6e6e73;margin:.0625rem 0 0}
.pg-bio{font-size:.75rem;color:#6e6e73;margin:0 0 1.125rem}
.pg-stack{display:flex;flex-direction:column}
.slot{display:grid;grid-template-rows:1fr;opacity:1;
 transition:grid-template-rows .3s cubic-bezier(.4,0,.2,1),opacity .22s ease}
.slot>.slot-in{overflow:hidden;min-height:0}
.slot>.slot-in>*{margin-bottom:.375rem}
.slot.gone{grid-template-rows:0fr;opacity:0}
.pg-section{font-size:.625rem;font-weight:600;letter-spacing:.07em;
 text-transform:uppercase;color:#8b8b8f;padding:.625rem 0 .1875rem}
.pg-block{display:flex;align-items:center;gap:.5rem;padding:.5625rem .6875rem;
 background:#fff;border:1px solid #e2e0da;border-radius:10px;position:relative;
 overflow:hidden}
.pg-block .bar{position:absolute;left:0;top:0;bottom:0;width:2px;
 background:var(--dim,transparent);opacity:0;transition:opacity .9s ease}
.pg-block.flash .bar{opacity:1;transition:opacity .06s ease}
.pg-block .ico{font-size:.8125rem;width:1rem;text-align:center;flex:none}
.pg-block .lab{font-size:.75rem;font-weight:500;flex:1;min-width:0;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap}
.pg-block .met{font-size:.625rem;color:#6e6e73;flex:none;max-width:7.5rem;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.pg-block .met.swapped{color:#1b4fd8}
.pg-foot{margin-top:1.5rem;font-size:.625rem;color:#8b8b8f}
.stage-cap{font-size:.75rem;color:var(--muted);text-align:center;max-width:20.5rem}
.stage-cap b{color:var(--ink);font-weight:500}
section.band{padding-block:4rem;border-top:1px solid var(--line)}
section.band:first-of-type{margin-top:3.5rem}
.band-head{max-width:46ch;margin-bottom:2.25rem}
.band-head h2{font-size:clamp(1.5rem,3.4vw,2rem);letter-spacing:-.028em;
 font-weight:600;margin:0;line-height:1.12;text-wrap:balance}
.band-head p{margin:.75rem 0 0;color:var(--muted);font-size:.9375rem}
.dim-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));
 gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;
 overflow:hidden}
.dim-cell{background:var(--panel);padding:1.125rem 1.25rem 1.25rem;display:flex;
 flex-direction:column;gap:.5rem}
.dim-cell h3{margin:0;font-size:.9375rem;font-weight:600;display:flex;
 align-items:center;gap:.5rem}
.dim-cell h3::before{content:"";width:3px;height:1rem;border-radius:2px;
 background:var(--dim);flex:none}
.dim-cell p{margin:0;font-size:.8125rem;color:var(--muted)}
.dim-cell code{font-family:var(--mono);font-size:.75rem;color:var(--dim);
 background:var(--dim-wash);padding:.375rem .5rem;border-radius:6px;display:block;
 overflow-x:auto;white-space:nowrap;margin-top:auto}
.ttl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));
 gap:1rem}
.ttl-card{border:1px solid var(--line);border-radius:10px;background:var(--panel);
 padding:1rem 1.125rem 1.125rem;display:flex;flex-direction:column;gap:.5rem}
.ttl-card .case{font-size:.8125rem;font-weight:500}
.ttl-card .hdr{font-family:var(--mono);font-size:.75rem;color:var(--ink);
 background:var(--sunk);border-radius:6px;padding:.5rem .625rem;overflow-x:auto;
 white-space:nowrap}
.ttl-card .hdr b{color:var(--ref);font-weight:500}
.ttl-card .hdr i{color:var(--alert);font-style:normal}
.ttl-card p{margin:0;font-size:.8125rem;color:var(--muted)}
.claim{border:1px solid var(--line);border-radius:12px;background:var(--panel);
 padding:1.75rem;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,21rem);
 gap:2rem;align-items:center}
@media (max-width:760px){.claim{grid-template-columns:minmax(0,1fr)}}
.claim h2{margin:0;font-size:1.5rem;letter-spacing:-.026em;font-weight:600}
.claim p{margin:.625rem 0 0;color:var(--muted);font-size:.875rem}
.claim-form{display:flex;flex-direction:column;gap:.5rem}
.claim-field{display:flex;align-items:center;border:1px solid var(--line-strong);
 border-radius:9px;background:var(--paper);padding:.125rem .125rem .125rem .6875rem;
 gap:.25rem}
.claim-field:focus-within{border-color:var(--geo);box-shadow:0 0 0 3px var(--geo-wash)}
.claim-field .pre{font-family:var(--mono);font-size:.8125rem;color:var(--muted);
 flex:none}
.claim-field input{font:inherit;font-family:var(--mono);font-size:.8125rem;border:0;
 background:none;color:var(--ink);padding:.5rem 0;flex:1;min-width:0;outline:none}
.claim-field button{font:inherit;font-size:.8125rem;font-weight:500;
 background:var(--ink);color:var(--panel);border:0;border-radius:7px;
 padding:.4375rem .875rem;cursor:pointer;flex:none}
.claim-field button:hover{opacity:.88}
.claim-msg{font-size:.75rem;min-height:1.2em;color:var(--muted);font-family:var(--mono)}
.claim-msg[data-ok="1"]{color:var(--ref)}
.claim-msg[data-ok="0"]{color:var(--alert)}
/* Dimension colour by attribute, never by a style attribute.
   A CSP hash covers a style block; it does not cover a style attribute on an
   element, and no hash can - the browser needs 'unsafe-hashes' for that. So
   every colour a dimension carries is set here and selected by data-dim, and
   the script toggles attributes rather than writing to .style. */
.dial[data-dim="geo"],.trace-line[data-dim="geo"]{--dim:var(--geo)}
.dial[data-dim="device"],.trace-line[data-dim="device"]{--dim:var(--device)}
.dial[data-dim="referrer"],.trace-line[data-dim="referrer"]{--dim:var(--ref)}
.dial[data-dim="lang"],.trace-line[data-dim="lang"]{--dim:var(--lang)}
.dial[data-dim="webview"],.trace-line[data-dim="webview"]{--dim:var(--wv)}
.dial[data-dim="time"],.trace-line[data-dim="time"]{--dim:var(--clock)}
.dim-cell[data-dim="geo"]{--dim:var(--geo);--dim-wash:var(--geo-wash)}
.dim-cell[data-dim="device"]{--dim:var(--device);--dim-wash:var(--device-wash)}
.dim-cell[data-dim="referrer"]{--dim:var(--ref);--dim-wash:var(--ref-wash)}
.dim-cell[data-dim="lang"]{--dim:var(--lang);--dim-wash:var(--lang-wash)}
.dim-cell[data-dim="clock"]{--dim:var(--clock);--dim-wash:var(--clock-wash)}
.dim-cell[data-dim="webview"]{--dim:var(--wv);--dim-wash:var(--wv-wash)}
/* The rail inside the phone is a literal: that region renders a creator's
   light theme and must not follow the visitor's dark mode. */
.pg-block[data-rail="geo"]{--dim:#1b4fd8}
.pg-block[data-rail="device"]{--dim:#5b3fc4}
.pg-block[data-rail="referrer"]{--dim:#0f6e56}
.pg-block[data-rail="lang"]{--dim:#9e2a5b}
.pg-block[data-rail="webview"]{--dim:#3f5566}
.pg-block[data-rail="time"]{--dim:#9c5a00}
.band-claim{border-top:0;padding-block:1rem 4rem}
footer{border-top:1px solid var(--line);padding-block:2rem 3rem;display:flex;
 flex-wrap:wrap;gap:1rem 2rem;align-items:center;justify-content:space-between;
 font-size:.8125rem;color:var(--muted)}
footer .links{display:flex;flex-wrap:wrap;gap:1.25rem}
`.trim();

/**
 * The demo profile, in the shape the evaluator really works on.
 *
 * Blocks carry a static rank; a rule carries conditions and exactly one action,
 * and the only two actions that exist are `hide` and `redirect`
 * (`lib/rules/schema.ts`). Ordering is not an action — `promote` and `show`
 * were removed from the vocabulary precisely because they never were one. A
 * demo that reordered blocks would be teaching a visitor a rule they cannot
 * write.
 */
function demoScript(): string {
  const reserved = JSON.stringify([...RESERVED_HANDLES]).replace(/</g, "\\u003c");
  return `(function(){"use strict";
var TZ=${JSON.stringify(DEMO_TZ)};

var BLOCKS=[
{id:"s-now",kind:"section",label:"Now"},
{id:"live",icon:"\\u25C9",label:"Live on Twitch \\u2014 right now",meta:"twitch.tv/ava"},
{id:"story",icon:"\\u2197",label:"The link from my story",meta:"avareyes.com/oct"},
{id:"s-listen",kind:"section",label:"Listen"},
{id:"single",icon:"\\u266A",label:"New single \\u2014 \\u201CCassette Weather\\u201D",meta:"open.spotify"},
{id:"presave",icon:"+",label:"Pre-save the album",meta:"needs sign-in"},
{id:"session",icon:"\\u25B6",label:"Studio session \\u2014 full set",meta:"youtube.com"},
{id:"s-dates",kind:"section",label:"Dates"},
{id:"tix-eu",icon:"\\u25C8",label:"Tickets \\u2014 Berlin, 12 Oct",meta:"ra.co"},
{id:"tix-lat",icon:"\\u25C8",label:"Ingressos \\u2014 S\\u00E3o Paulo, 3 Nov",meta:"sympla.com.br"},
{id:"s-more",kind:"section",label:"More"},
{id:"merch",icon:"\\u25A3",label:"Merch",meta:"store.avareyes.com"},
{id:"app",icon:"\\u25A2",label:"Get the app",meta:"iOS \\u00B7 Android"},
{id:"es",icon:"\\u25D1",label:"P\\u00E1gina en espa\\u00F1ol",meta:"es.avareyes.com"},
{id:"press",icon:"\\u25A4",label:"Press kit & booking",meta:"PDF \\u00B7 4.2 MB"}];

/* Which section each block sits under, so a section with nothing left under it
   disappears too. */
var SECTION_OF={live:"s-now",story:"s-now",single:"s-listen",presave:"s-listen",
session:"s-listen","tix-eu":"s-dates","tix-lat":"s-dates",merch:"s-more",
app:"s-more",es:"s-more",press:"s-more"};

var RULES=[
{id:"r1",block:"live",dim:"time",
 test:function(c){return !(c.hour>=21&&c.hour<23)},act:"hide",
 why:"outside 21:00\\u201323:00 "+TZ,whyOn:"inside 21:00\\u201323:00 "+TZ},
{id:"r2",block:"story",dim:"referrer",
 test:function(c){return c.referrer!=="ig"&&c.referrer!=="tt"},act:"hide",
 why:"referrer not in [ig, tt]",whyOn:"referrer in [ig, tt]"},
{id:"r3",block:"presave",dim:"webview",
 test:function(c){return c.webview},act:"hide",why:"webview is true"},
{id:"r4",block:"session",dim:"referrer",
 test:function(c){return c.referrer==="yt"},act:"hide",
 why:"referrer in [yt] \\u2014 they just came from there"},
{id:"r5",block:"tix-eu",dim:"geo",
 test:function(c){return c.geo!=="eu"},act:"hide",
 why:"geo not in [eu]",whyOn:"geo in [eu]"},
{id:"r6",block:"tix-lat",dim:"geo",
 test:function(c){return c.geo!=="latam"},act:"hide",
 why:"geo not in [latam]",whyOn:"geo in [latam]"},
{id:"r7",block:"merch",dim:"geo",
 test:function(c){return c.geo==="eu"||c.geo==="na"},act:"redirect",
 target:function(c){return c.geo==="eu"?"eu.store.avareyes":"us.store.avareyes"},
 why:"geo in [eu, na] \\u2192 regional store, 307"},
{id:"r8",block:"app",dim:"device",
 test:function(c){return c.device==="desktop"},act:"hide",why:"device in [desktop]"},
{id:"r9",block:"es",dim:"lang",
 test:function(c){return c.lang!=="es"&&c.lang!=="pt"},act:"hide",
 why:"lang not in [es, pt]",whyOn:"lang in [es, pt]"},
{id:"r10",block:"press",dim:"device",
 test:function(c){return c.device==="mobile"},act:"hide",why:"device in [mobile]"}];

/* ---- reading the visitor -------------------------------------------------
   On the deployed site this is CloudFront's job, done in a viewer-request
   function from its own headers before the origin is asked for anything. Here
   it is the browser's, because this document is one cache entry served to
   everyone. The page says so rather than implying otherwise. */

var LATAM=/^America\\/(Mexico|Cancun|Merida|Monterrey|Chihuahua|Tijuana|Bogota|Lima|Caracas|Santiago|Argentina|Buenos_Aires|Sao_Paulo|Bahia|Fortaleza|Recife|Manaus|Montevideo|Asuncion|La_Paz|Guayaquil|Panama|Costa_Rica|Guatemala|El_Salvador|Tegucigalpa|Managua|Havana|Santo_Domingo|Puerto_Rico)/;
var MEA=/^(Africa\\/|Asia\\/(Dubai|Riyadh|Qatar|Kuwait|Bahrain|Baghdad|Tehran|Jerusalem|Beirut|Damascus|Amman|Muscat|Aden|Istanbul|Tbilisi|Yerevan|Baku)|Europe\\/Istanbul)/;
var APAC=/^(Asia\\/|Australia\\/|Pacific\\/|Indian\\/)/;
var EU=/^(Europe\\/|Atlantic\\/(Reykjavik|Canary|Madeira|Faroe))/;
var NA=/^(America\\/|US\\/|Canada\\/)/;

/* Byte-identical to WEBVIEW in api/edge/page.js and lib/context/visitor.ts.
   Three copies classify the same viewer; a disagreement means one of them
   serves a page cached under the other's answer. */
var WEBVIEW=/Instagram|FBAV|FBAN|FB_IAB|TikTok|Line\\/|MicroMessenger|Snapchat|Pinterest/;

function geoFromTz(tz){
 if(!tz)return "xx";
 if(LATAM.test(tz))return "latam";
 if(MEA.test(tz))return "mea";
 if(EU.test(tz))return "eu";
 if(APAC.test(tz))return "apac";
 if(NA.test(tz))return "na";
 return "xx";}

function deviceOf(){
 var ua=navigator.userAgent||"";
 if(/iPad|Tablet|PlayBook|Silk/.test(ua)||(/Android/.test(ua)&&!/Mobile/.test(ua)))return "tablet";
 if(/Mobi|iPhone|iPod|Android|Windows Phone/.test(ua))return "mobile";
 /* A coarse pointer at phone width is a phone whatever the user-agent claims,
    which is how desktop-mode Safari arrives. */
 if(window.matchMedia&&window.matchMedia("(pointer: coarse)").matches&&window.innerWidth<820){
  return window.innerWidth<560?"mobile":"tablet";}
 return "desktop";}

/* refClass from api/edge/page.js, unchanged. */
function refClass(ref){
 if(!ref)return "dir";
 var m=ref.match(/^https?:\\/\\/([^/?#]+)/);
 if(!m)return "oth";
 var h=m[1].toLowerCase();
 if(h.indexOf("instagram")>=0)return "ig";
 if(h.indexOf("tiktok")>=0)return "tt";
 if(h.indexOf("linkedin")>=0||h==="lnkd.in")return "li";
 if(h.indexOf("youtube")>=0||h==="youtu.be")return "yt";
 if(h.indexOf("twitter")>=0||h==="t.co"||h.indexOf("x.com")>=0)return "x";
 if(h.indexOf("facebook")>=0||h==="fb.me")return "fb";
 return "oth";}

var LANGS=["en","es","pt","de","fr","ja","ar"];

function hourIn(tz,date){
 try{return parseInt(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",hour12:false,
  timeZone:tz}).format(date),10)%24}catch(e){return date.getHours()}}

function readVisitor(){
 var tz="";
 try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||""}catch(e){}
 var lang=(navigator.language||"en").slice(0,2).toLowerCase();
 return{geo:geoFromTz(tz),device:deviceOf(),referrer:refClass(document.referrer),
  lang:LANGS.indexOf(lang)>=0?lang:"en",webview:WEBVIEW.test(navigator.userAgent||""),
  hour:hourIn(TZ,new Date()),tz:tz};}

/* ---- the evaluator ------------------------------------------------------ */

var DAY=86400;

function resolve(ctx){
 var hidden={},retarget={},fired=[];
 RULES.forEach(function(r){
  if(!r.test(ctx)){
   if(r.whyOn)fired.push({id:r.id,dim:r.dim,block:r.block,act:"keep",why:r.whyOn});
   return;}
  if(r.act==="hide")hidden[r.block]=true;else retarget[r.block]=r.target(ctx);
  fired.push({id:r.id,dim:r.dim,block:r.block,act:r.act,why:r.why});});
 var alive={};
 Object.keys(SECTION_OF).forEach(function(b){
  if(!hidden[b])alive[SECTION_OF[b]]=true;});
 BLOCKS.forEach(function(b){
  if(b.kind==="section"&&!alive[b.id])hidden[b.id]=true;});
 return{hidden:hidden,retarget:retarget,fired:fired,sMaxAge:nextBoundary(ctx)};}

/* The lifetime is the distance to the next instant any decision on this page
   could change. Only the clock moves on its own, so only the clock sets it. */
function nextBoundary(ctx){
 var now=ctx.hour*3600,edges=[21*3600,23*3600],best=DAY,i,d;
 for(i=0;i<edges.length;i++){d=edges[i]-now;if(d<=0)d+=DAY;if(d<best)best=d;}
 return best;}

function human(sec){
 var h=Math.floor(sec/3600),m=Math.round((sec%3600)/60);
 if(h&&m)return h+"h "+m+"m";
 if(h)return h+"h";
 return m+"m";}

function pad(n){return (n<10?"0":"")+n}

/* ---- rendering ---------------------------------------------------------- */

var stack=document.getElementById("stack"),slots={};
BLOCKS.forEach(function(b){
 var slot=document.createElement("div");slot.className="slot";
 var inner=document.createElement("div");inner.className="slot-in";
 if(b.kind==="section"){
  var s=document.createElement("div");s.className="pg-section";
  s.textContent=b.label;inner.appendChild(s);
 }else{
  var row=document.createElement("div");row.className="pg-block";
  row.innerHTML='<i class="bar"></i><span class="ico"></span>'+
   '<span class="lab"></span><span class="met"></span>';
  row.querySelector(".ico").textContent=b.icon;
  row.querySelector(".lab").textContent=b.label;
  row.querySelector(".met").textContent=b.meta;
  inner.appendChild(row);}
 slot.appendChild(inner);stack.appendChild(slot);slots[b.id]=slot;});

var escapeSlot=document.getElementById("slot-escape"),
 traceEl=document.getElementById("trace"),countEl=document.getElementById("res-count"),
 keyEl=document.getElementById("l-key"),ttlEl=document.getElementById("l-ttl"),
 nextEl=document.getElementById("l-next"),capEl=document.getElementById("stage-cap"),
 ttlDemo=document.getElementById("ttl-demo");

var GEO_WORD={na:"North America",eu:"Europe",apac:"Asia-Pacific",
latam:"Latin America",mea:"the Middle East & Africa",xx:"somewhere"};
var REF_WORD={ig:"Instagram",tt:"TikTok",yt:"YouTube",x:"X",li:"LinkedIn",
fb:"Facebook",dir:"a typed link",oth:"another site"};
var DEV_WORD={mobile:"a phone",tablet:"a tablet",desktop:"a desktop"};

var first=true;

function paint(ctx,changed){
 var r=resolve(ctx),shown=0;
 BLOCKS.forEach(function(b){
  var slot=slots[b.id],isHidden=!!r.hidden[b.id],was=slot.classList.contains("gone");
  slot.classList.toggle("gone",isHidden);
  if(!isHidden&&b.kind!=="section")shown++;
  if(b.kind==="section")return;
  var met=slot.querySelector(".met"),tgt=r.retarget[b.id];
  met.textContent=tgt||b.meta;
  met.classList.toggle("swapped",!!tgt);
  /* A block that just changed flashes a rail in the colour of the dial that
     changed it \\u2014 the same language the editor's block rows use. */
  if(!first&&changed&&(was!==isHidden||(tgt&&changed==="geo"))){
   var row=slot.querySelector(".pg-block");
   row.setAttribute("data-rail",changed);
   row.classList.remove("flash");void row.offsetWidth;row.classList.add("flash");}});

 escapeSlot.classList.toggle("gone",!ctx.webview);

 traceEl.textContent="";
 var acted=r.fired.filter(function(f){return f.act!=="keep"});
 if(!r.fired.length){
  var none=document.createElement("div");none.className="trace-line none";
  none.textContent="no rule matched \\u2014 every visitor gets this exact page";
  traceEl.appendChild(none);
 }else{
  r.fired.slice(0,7).forEach(function(f){
   var el=document.createElement("div");el.className="trace-line";
   el.setAttribute("data-dim",f.dim);
   el.innerHTML='<span class="rid"></span><span class="what"></span>'+
    '<span class="why"></span>';
   el.querySelector(".rid").textContent=f.id;
   el.querySelector(".what").textContent=
    (f.act==="hide"?"hide ":f.act==="redirect"?"retarget ":"keep ")+f.block;
   el.querySelector(".why").textContent=f.dim;
   el.title=f.why;
   traceEl.appendChild(el);});}

 countEl.textContent=shown+" of 11 blocks \\u00B7 "+acted.length+" rules fired";

 /* Five fixed slots in gdrlw order, positional, exactly as the edge writes it. */
 keyEl.textContent="v7|"+ctx.geo+"."+ctx.device.charAt(0)+"."+ctx.referrer+"."+
  ctx.lang+"."+(ctx.webview?"1":"0");
 ttlEl.textContent="public, s-maxage="+r.sMaxAge;
 nextEl.textContent=((ctx.hour>=21&&ctx.hour<23)?"23:00":"21:00")+" "+TZ+
  " \\u00B7 in "+human(r.sMaxAge);
 if(ttlDemo)ttlDemo.textContent=String(r.sMaxAge);

 if(isMe(ctx)){
  capEl.innerHTML="Ava's page, as <b>you<\\/b> would get it.";
 }else{
  capEl.innerHTML="Ava's page for someone on <b>"+DEV_WORD[ctx.device]+
   "<\\/b> in <b>"+GEO_WORD[ctx.geo]+"<\\/b>, arriving from <b>"+
   REF_WORD[ctx.referrer]+"<\\/b> at <b>"+pad(ctx.hour)+":00<\\/b>.";}

 first=false;}

/* ---- controls ----------------------------------------------------------- */

var me=readVisitor();
var ctx={geo:me.geo,device:me.device,referrer:me.referrer,lang:me.lang,
 webview:me.webview,hour:me.hour};

function isMe(c){return c.geo===me.geo&&c.device===me.device&&
 c.referrer===me.referrer&&c.lang===me.lang&&c.webview===me.webview&&c.hour===me.hour}

var elGeo=document.getElementById("d-geo"),elDev=document.getElementById("d-device"),
 elRef=document.getElementById("d-ref"),elLang=document.getElementById("d-lang"),
 elWv=document.getElementById("d-wv"),elHour=document.getElementById("d-hour"),
 elHourVal=document.getElementById("hourval"),
 ctxSource=document.getElementById("ctx-source"),
 readCopy=document.getElementById("read-copy");

function syncControls(){
 elGeo.value=ctx.geo;elDev.value=ctx.device;elRef.value=ctx.referrer;
 elLang.value=ctx.lang;
 elWv.setAttribute("aria-pressed",ctx.webview?"true":"false");
 elWv.querySelector(".state").textContent=String(ctx.webview);
 elHour.value=String(ctx.hour);elHourVal.textContent=pad(ctx.hour)+":00";
 var dials=document.querySelectorAll(".dial"),i,d,dim,same;
 for(i=0;i<dials.length;i++){
  d=dials[i];dim=d.getAttribute("data-dim");
  same=dim==="geo"?ctx.geo===me.geo:dim==="device"?ctx.device===me.device:
   dim==="referrer"?ctx.referrer===me.referrer:dim==="lang"?ctx.lang===me.lang:
   dim==="webview"?ctx.webview===me.webview:ctx.hour===me.hour;
  d.setAttribute("data-active",same?"0":"1");}}

function change(dim,apply){
 return function(){apply();syncControls();paint(ctx,dim)}}

elGeo.addEventListener("change",change("geo",function(){ctx.geo=elGeo.value}));
elDev.addEventListener("change",change("device",function(){ctx.device=elDev.value}));
elRef.addEventListener("change",change("referrer",function(){ctx.referrer=elRef.value}));
elLang.addEventListener("change",change("lang",function(){ctx.lang=elLang.value}));
elWv.addEventListener("click",change("webview",function(){ctx.webview=!ctx.webview}));
elHour.addEventListener("input",change("time",function(){
 ctx.hour=parseInt(elHour.value,10)}));

document.getElementById("reset-ctx").addEventListener("click",function(){
 ctx.geo=me.geo;ctx.device=me.device;ctx.referrer=me.referrer;ctx.lang=me.lang;
 ctx.webview=me.webview;ctx.hour=me.hour;syncControls();paint(ctx,null);});

var told=[];
if(me.tz)told.push(me.tz);
told.push(DEV_WORD[me.device].replace("a ",""));
told.push(me.referrer==="dir"?"no referrer":REF_WORD[me.referrer]);
told.push(navigator.language||me.lang);
ctxSource.textContent="read at load";
readCopy.textContent="Read from your browser just now \\u2014 "+told.join(" \\u00B7 ")+
 ". On the live site the CDN does this from its own headers before the page is "+
 "built. Nothing stored, no cookie set.";

syncControls();
paint(ctx,null);

/* ---- the claim field ----------------------------------------------------
   The same rules the backend enforces. The form is a plain GET to /signup, so
   it still works with this script disabled; everything here is the message
   that saves a visitor the round trip. */

var RESERVED=${reserved};
${HANDLE_VALIDATOR_SOURCE}

var input=document.getElementById("handle"),msg=document.getElementById("claim-msg");

input.addEventListener("input",function(){
 var v=input.value.trim().toLowerCase();
 if(!v){msg.textContent="";msg.removeAttribute("data-ok");return;}
 var p=problem(v,RESERVED);
 if(p){msg.textContent=p;msg.setAttribute("data-ok","0");}
 else{msg.textContent="chamelink.app/"+v+" looks free.";msg.setAttribute("data-ok","1");}});

document.getElementById("claim").addEventListener("submit",function(e){
 var v=input.value.trim().toLowerCase(),p=v?problem(v,RESERVED):"Pick something first.";
 if(p){e.preventDefault();msg.textContent=p;msg.setAttribute("data-ok","0");input.focus();}
 else{input.value=v;}});
})();`;
}

/** Minimal HTML escaping, for the few places an option value reaches markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHomeDocument({ origin }: HomeOptions): HomeDocument {
  const style = STYLE;
  const script = demoScript();
  const canonical = safeHref(origin || "/");
  const title = "Chamelink — one link that reads the room";
  const description =
    "A link in bio that resolves per visitor: region, device, where they clicked " +
    "from, language, in-app browser and time of day, decided at the CDN edge.";

  /* The app's existing icon, not a second mark. Next serves `app/icon.svg` at
     that path automatically, but it only injects the <link> into documents it
     renders — a route handler writes its own head, so this is explicit. */

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Chamelink",
    url: canonical,
    description,
  }).replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<style>${style}</style>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<div class="wrap">

<header class="masthead">
  <div class="mark">
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" fill="none">
      <path class="tail" d="M2 4.2c4.6 0 7.3 2 8.7 4.6 1.5 2.8 1 5.9-1.1 7.3-2 1.3-4.3.4-4.8-1.5-.5-1.8.8-3.4 2.5-3.3 1.6.1 2.5 1.4 2.3 2.7" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
      <circle cx="19" cy="5" r="1.6" fill="currentColor"></circle>
    </svg>
    chamelink
  </div>
  <nav>
    <a class="hide-sm" href="#dials">How it works</a>
    <a class="hide-sm" href="#cache">Caching</a>
    <a class="signin" href="/login">Sign in</a>
  </nav>
</header>

<div class="hero">
  <p class="eyebrow">Live on this page</p>
  <h1>One link that <em>reads the room</em>.</h1>
  <p class="lede">Your link-in-bio resolves per visitor &mdash; region, device, where they
    clicked from, language, in-app browser, time of day &mdash; decided at the CDN edge in
    one round trip. Below is a creator's page, resolved for <b>you</b>. Change a dial and
    watch it become someone else's.</p>

  <div class="desk">
    <div class="deskcol">

      <div class="panel">
        <div class="panel-head">
          <h2>Visitor context</h2>
          <span class="sub" id="ctx-source">read at load</span>
        </div>
        <div class="dials">
          <div class="dial" data-dim="geo">
            <span class="dial-name"><i class="rail"></i><b>geo</b></span>
            <span class="dial-control">
              <select class="pick" id="d-geo" aria-label="Region">
                <option value="na">North America</option>
                <option value="eu">Europe</option>
                <option value="apac">Asia-Pacific</option>
                <option value="latam">Latin America</option>
                <option value="mea">Middle East &amp; Africa</option>
                <option value="xx">Unclassified</option>
              </select>
            </span>
          </div>
          <div class="dial" data-dim="device">
            <span class="dial-name"><i class="rail"></i><b>device</b></span>
            <span class="dial-control">
              <select class="pick" id="d-device" aria-label="Device">
                <option value="mobile">Mobile</option>
                <option value="tablet">Tablet</option>
                <option value="desktop">Desktop</option>
              </select>
            </span>
          </div>
          <div class="dial" data-dim="referrer">
            <span class="dial-name"><i class="rail"></i><b>referrer</b></span>
            <span class="dial-control">
              <select class="pick" id="d-ref" aria-label="Arrived from">
                <option value="ig">Instagram</option>
                <option value="tt">TikTok</option>
                <option value="yt">YouTube</option>
                <option value="x">X</option>
                <option value="li">LinkedIn</option>
                <option value="fb">Facebook</option>
                <option value="dir">Typed or pasted</option>
                <option value="oth">Somewhere else</option>
              </select>
            </span>
          </div>
          <div class="dial" data-dim="lang">
            <span class="dial-name"><i class="rail"></i><b>lang</b></span>
            <span class="dial-control">
              <select class="pick" id="d-lang" aria-label="Language">
                <option value="en">English</option>
                <option value="es">Espa&ntilde;ol</option>
                <option value="pt">Portugu&ecirc;s</option>
                <option value="de">Deutsch</option>
                <option value="fr">Fran&ccedil;ais</option>
                <option value="ja">&#26085;&#26412;&#35486;</option>
                <option value="ar">&#1575;&#1604;&#1593;&#1585;&#1576;&#1610;&#1577;</option>
              </select>
            </span>
          </div>
          <div class="dial" data-dim="webview">
            <span class="dial-name"><i class="rail"></i><b>webview</b></span>
            <span class="dial-control">
              <button class="toggle" id="d-wv" type="button" aria-pressed="false">
                <span>In-app browser</span><span class="state">false</span>
              </button>
            </span>
          </div>
          <div class="dial" data-dim="time">
            <span class="dial-name"><i class="rail"></i><b>time</b></span>
            <span class="dial-control">
              <span class="clockrow">
                <input type="range" id="d-hour" min="0" max="23" step="1" value="14"
                       aria-label="Hour, ${esc(DEMO_TZ)}">
                <span class="clockval tnum" id="hourval">14:00</span>
              </span>
            </span>
          </div>
        </div>
        <p class="readnote">
          <span id="read-copy">Read from your browser &mdash; timezone, user-agent,
            referrer, Accept-Language. On the live site the CDN does this from its own
            headers before the page is built. Nothing stored, no cookie set.</span>
          <button type="button" id="reset-ctx">Reset to me</button>
        </p>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Resolution</h2>
          <span class="sub" id="res-count">&mdash;</span>
        </div>
        <div class="trace" id="trace"></div>
        <div class="ledger">
          <dl>
            <dt>cache-key</dt><dd class="key tnum" id="l-key">&mdash;</dd>
            <dt>cache-control</dt><dd class="ttl tnum" id="l-ttl">&mdash;</dd>
            <dt>next boundary</dt><dd class="tnum" id="l-next">&mdash;</dd>
          </dl>
        </div>
      </div>

    </div>

    <div class="stage">
      <div class="phone">
        <div class="screen">
          <div class="urlbar">
            <svg class="lock" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.4 4.4V3a2.6 2.6 0 0 1 5.2 0v1.4" fill="none" stroke="#6e6e73" stroke-width="1"></path>
              <rect x="1.6" y="4.4" width="6.8" height="4.6" rx="1.1" fill="#6e6e73"></rect>
            </svg>
            chamelink.app/<b>ava</b>
          </div>
          <div class="screen-scroll">
            <div class="slot gone" id="slot-escape"><div class="slot-in">
              <div class="pg-escape">
                <span class="i">&#8599;</span>
                <span>You're in an in-app browser. Some links won't work here.
                  <u>Open in Safari</u></span>
              </div>
            </div></div>
            <div class="pg-head">
              <div class="pg-avatar"></div>
              <div>
                <h3 class="pg-name">Ava Reyes</h3>
                <p class="pg-handle">@ava</p>
              </div>
            </div>
            <p class="pg-bio">Producer. Berlin &harr; S&atilde;o Paulo.</p>
            <div class="pg-stack" id="stack"></div>
            <p class="pg-foot">ava</p>
          </div>
        </div>
      </div>
      <p class="stage-cap" id="stage-cap">Ava's page, as <b>you</b> would get it.</p>
    </div>
  </div>
</div>

<section class="band" id="dials">
  <div class="band-head">
    <h2>Five dials and a clock</h2>
    <p>Every dimension is something the edge already knows before your page is built, so
      reading it costs nothing. A rule is a set of conditions and one action &mdash; hide a
      block, or send it somewhere else.</p>
  </div>
  <div class="dim-grid">
    <div class="dim-cell" data-dim="geo">
      <h3>Region</h3>
      <p>Six coarse buckets from the viewer's country. Coarse on purpose: a bucket is one
        cache entry, a country is two hundred.</p>
      <code>when geo in [eu] &rarr; show tickets</code>
    </div>
    <div class="dim-cell" data-dim="device">
      <h3>Device</h3>
      <p>Mobile, tablet, desktop. The press kit is a 4&nbsp;MB PDF &mdash; nobody wants that
        on a phone, and nobody wants the app badge on a laptop.</p>
      <code>when device in [mobile] &rarr; hide press-kit</code>
    </div>
    <div class="dim-cell" data-dim="referrer">
      <h3>Source</h3>
      <p>Instagram, TikTok, YouTube, X, LinkedIn, Facebook, direct, other. The link in your
        story can point at the thing your story was about.</p>
      <code>when referrer in [yt] &rarr; hide watch-on-yt</code>
    </div>
    <div class="dim-cell" data-dim="lang">
      <h3>Language</h3>
      <p>The two-letter code the browser already sends. Offer the Spanish store to the
        people who would have gone looking for it.</p>
      <code>when lang in [es, pt] &rarr; show es-site</code>
    </div>
    <div class="dim-cell" data-dim="clock">
      <h3>Time window</h3>
      <p>A window in a real IANA timezone, with real DST. "Live now" is only true while it
        is true, and the cache knows exactly when that stops.</p>
      <code>when 21:00&ndash;23:00 ${esc(DEMO_TZ)} &rarr; show live</code>
    </div>
    <div class="dim-cell" data-dim="webview">
      <h3>In-app browser</h3>
      <p>Instagram, TikTok, Messenger and WeChat open links in a browser that breaks OAuth.
        Hide what can't work there, and offer the way out.</p>
      <code>when webview is true &rarr; hide pre-save</code>
    </div>
  </div>
</section>

<section class="band" id="cache">
  <div class="band-head">
    <h2>A page that changes is a page that can be cached wrong</h2>
    <p>This is the part everyone else skips. If one visitor's answer is served to the next
      one, a context-aware page is worse than a static page &mdash; so the cache key and the
      lifetime are the product, not an afterthought.</p>
  </div>
  <div class="ttl-grid">
    <div class="ttl-card">
      <span class="case">No rule reads the clock</span>
      <span class="hdr">cache-control: public, s-maxage=<b>3600</b></span>
      <p>Nothing about this answer expires on its own. It sits at the edge until the ceiling
        or until the creator publishes, whichever comes first.</p>
    </div>
    <div class="ttl-card">
      <span class="case">A window opens at 21:00</span>
      <span class="hdr">cache-control: public, s-maxage=<b id="ttl-demo">4213</b></span>
      <p>The lifetime is the distance to the next instant any decision on this page could
        change &mdash; to the second, computed by the evaluator that made it.</p>
    </div>
    <div class="ttl-card">
      <span class="case">The key predates the rules</span>
      <span class="hdr">cache-control: <i>no-store</i></span>
      <p>A new rule started reading language, but the edge keyed this request under the old
        mask. Rather than store an answer under a key that can't tell Spanish from English,
        it stores nothing.</p>
    </div>
  </div>
</section>

<section class="band band-claim">
  <div class="claim">
    <div>
      <h2>Take a handle.</h2>
      <p>Two to thirty characters, lowercase, numbers, dashes and underscores. One page, as
        many versions of it as you need.</p>
    </div>
    <form class="claim-form" id="claim" method="get" action="/signup">
      <div class="claim-field">
        <span class="pre">chamelink.app/</span>
        <input id="handle" name="handle" type="text" autocomplete="off" spellcheck="false"
               placeholder="ava" aria-label="Your handle" aria-describedby="claim-msg"
               maxlength="30">
        <button type="submit">Claim</button>
      </div>
      <p class="claim-msg" id="claim-msg"></p>
    </form>
  </div>
</section>

<footer>
  <span>&copy; 2026 Chamelink</span>
  <span class="links">
    <a href="#dials">How it works</a>
    <a href="#cache">Caching</a>
    <a href="/login">Sign in</a>
    <a href="/signup">Create an account</a>
  </span>
</footer>

</div>
<script>${script}</script>
</body>
</html>`;

  return { html, style, script };
}
