import type { Theme } from "@/lib/api/types";

/**
 * The public page ships no framework and no external stylesheet. Its entire
 * appearance is a handful of custom properties written into a <style> block, so
 * a creator's theme costs one extra inline declaration rather than a class
 * bundle, and the first paint needs exactly one round trip.
 */

interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  lineStrong: string;
}

const PALETTES: Record<Theme["preset"], Palette> = {
  paper: {
    bg: "#F7F6F3",
    surface: "#FFFFFF",
    ink: "#16161A",
    muted: "#6E6E73",
    line: "#E2E0DA",
    lineStrong: "#C9C6BD",
  },
  ink: {
    bg: "#111214",
    surface: "#191B1E",
    ink: "#F2F2F0",
    muted: "#9A9CA1",
    line: "#2A2D31",
    lineStrong: "#3D4147",
  },
  signal: {
    bg: "#FFFFFF",
    surface: "#FFFFFF",
    ink: "#0E1116",
    muted: "#5C6672",
    line: "#DCE1E8",
    lineStrong: "#0E1116",
  },
};

const TYPEFACES: Record<Theme["typeface"], string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  grotesque: '"Helvetica Neue", Helvetica, Arial, sans-serif',
};

const RADII: Record<Theme["cornerStyle"], string> = {
  pill: "999px",
  soft: "10px",
  square: "0px",
};

export function themeVariables(theme: Theme): string {
  const p = PALETTES[theme.preset] ?? PALETTES.paper;
  return [
    `--bg:${p.bg}`,
    `--surface:${p.surface}`,
    `--ink:${p.ink}`,
    `--muted:${p.muted}`,
    `--line:${p.line}`,
    `--line-strong:${p.lineStrong}`,
    `--accent:${safeColor(theme.accent) ?? p.ink}`,
    `--type:${TYPEFACES[theme.typeface] ?? TYPEFACES.system}`,
    `--radius:${RADII[theme.cornerStyle] ?? RADII.soft}`,
  ].join(";");
}

/** Themes are creator-supplied, so the accent is validated before it reaches CSS. */
export function safeColor(value: string | undefined): string | null {
  if (!value) return null;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : null;
}

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--type);
 font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{max-width:29rem;margin:0 auto;padding:3.5rem 1.25rem 5rem}
a{color:inherit;text-decoration:none}
.head{display:flex;gap:.875rem;align-items:center;margin-bottom:.875rem}
.avatar{width:56px;height:56px;border-radius:999px;object-fit:cover;flex:none;
 background:var(--line)}
.name{font-size:1.375rem;font-weight:600;letter-spacing:-.018em;margin:0;line-height:1.15}
.handle{font-size:.8125rem;color:var(--muted);margin:.125rem 0 0}
.bio{font-size:.9375rem;color:var(--muted);margin:0 0 2rem;max-width:26rem}
.countdown{display:flex;align-items:baseline;gap:.5rem;margin:0 0 1.75rem;
 padding-bottom:1rem;border-bottom:1px solid var(--line)}
.countdown b{font-size:1.75rem;font-weight:600;letter-spacing:-.02em;
 font-variant-numeric:tabular-nums}
.countdown span{font-size:.8125rem;color:var(--muted)}
.stack{display:flex;flex-direction:column;gap:.5rem}
.block{display:flex;align-items:center;gap:.75rem;width:100%;padding:.9375rem 1.125rem;
 background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
 transition:border-color .12s ease,transform .12s ease}
.block:hover{border-color:var(--line-strong)}
.block:active{transform:translateY(1px)}
.block:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.block-icon{font-size:1.0625rem;line-height:1;flex:none;width:1.25rem;text-align:center}
.block-label{font-size:.9375rem;font-weight:500;flex:1;min-width:0}
.block-meta{font-size:.75rem;color:var(--muted);flex:none;max-width:9rem;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tick{width:6px;height:6px;border-radius:999px;background:var(--accent);flex:none}
.feed{display:block;padding:.875rem 1.125rem}
.feed-title{font-size:.75rem;color:var(--muted);margin:0 0 .625rem}
.feed-item{display:flex;justify-content:space-between;gap:1rem;padding:.4375rem 0;
 border-top:1px solid var(--line);font-size:.875rem}
.feed-item:first-of-type{border-top:0;padding-top:0}
.feed-item em{font-style:normal;color:var(--muted);font-size:.8125rem;flex:none}
.note{font-size:.9375rem;color:var(--muted);padding:.25rem 0 .5rem;margin:0}
.section{font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
 color:var(--muted);margin:1.25rem 0 .125rem;padding:0}
.stack>.section:first-child{margin-top:0}
.embed{width:100%;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);
 background:var(--surface)}
.embed iframe{display:block;width:100%;height:100%;border:0}
.foot{margin-top:2.5rem;font-size:.75rem;color:var(--muted)}
#escape{display:none;align-items:center;gap:.75rem;padding:.75rem 1rem;margin:-1.5rem 0 1.75rem;
 border:1px solid var(--line-strong);border-radius:var(--radius);font-size:.8125rem;
 background:var(--surface)}
#escape button{font:inherit;font-weight:500;color:var(--accent);background:none;
 border:0;padding:0;cursor:pointer;text-decoration:underline;flex:none}
@media (prefers-reduced-motion:reduce){.block{transition:none}}
`.trim();
