import { describe, expect, it } from "vitest";
import { resolveEmbed, EMBED_HOSTS } from "./site/embed";
import { renderProfileDocument } from "./site/render";
import { feedRefProblem } from "./feeds";
import type { Resolution, ResolvedBlock } from "./api/types";

// ---------------------------------------------------------------- embeds

describe("the embed allowlist", () => {
  it("turns YouTube share links of every shape into the no-cookie player", () => {
    const player = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(resolveEmbed(url)?.src, url).toBe(player);
    }
  });

  it("carries a start time through", () => {
    expect(resolveEmbed("https://youtu.be/dQw4w9WgXcQ?t=42s")?.src).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    );
  });

  it("sizes a Spotify track differently from a playlist", () => {
    // Guessing wrong leaves a 380px void under a one-line track, or a scrollbar
    // on a fifty-track list.
    expect(resolveEmbed("https://open.spotify.com/track/abc123")?.ratio).toBe("16 / 5");
    expect(resolveEmbed("https://open.spotify.com/playlist/abc123")?.ratio).toBe("1 / 1");
  });

  it("accepts Spotify's localised paths", () => {
    expect(resolveEmbed("https://open.spotify.com/intl-de/album/xyz?si=1")?.src).toBe(
      "https://open.spotify.com/embed/album/xyz",
    );
  });

  it("refuses anything not on the list", () => {
    // The point of the allowlist: a creator cannot frame an arbitrary page
    // inside their own profile, and `frame-src` stays enumerable.
    for (const url of [
      "https://evil.test/phish",
      "https://docs.google.com/document/d/x",
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "not a url",
    ]) {
      expect(resolveEmbed(url), url).toBeNull();
    }
  });

  it("refuses a lookalike host", () => {
    expect(resolveEmbed("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(resolveEmbed("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("refuses a YouTube URL with no video in it", () => {
    expect(resolveEmbed("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(resolveEmbed("https://www.youtube.com/feed/subscriptions")).toBeNull();
  });

  it("only ever returns a host the CSP knows about", () => {
    // If a provider is added without extending EMBED_HOSTS the frame silently
    // never loads, because the page is default-src 'none'.
    const urls = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://open.spotify.com/track/abc123",
      "https://soundcloud.com/artist/track",
      "https://vimeo.com/123456",
      "https://music.apple.com/us/album/x/123",
    ];
    for (const url of urls) {
      const e = resolveEmbed(url);
      expect(e, url).not.toBeNull();
      expect(EMBED_HOSTS as readonly string[]).toContain(e!.host);
    }
  });
});

// ---------------------------------------------------------------- rendering

function page(blocks: ResolvedBlock[]) {
  const resolution = {
    profile: {
      handle: "erin",
      displayName: "Erin",
      bio: "",
      mode: "standard",
      theme: { preset: "paper", accent: "#1b4fd8", typeface: "grotesque", cornerStyle: "soft" },
    },
    blocks,
    sMaxAge: 300,
    varyOn: [],
    warnings: [],
  } as unknown as Resolution;

  return renderProfileDocument({
    resolution,
    origin: "https://linkb.io",
    beaconUrl: "https://api.linkb.io/v1/events",
  });
}

const link = (over: Partial<ResolvedBlock> = {}): ResolvedBlock => ({
  id: "b1",
  kind: "link",
  label: "Presave",
  href: "/r/erin/b1",
  target: "https://open.spotify.com/album/x",
  ...over,
});

describe("the renderer covers exactly the backend's block kinds", () => {
  it("a header is a heading, not a link card", () => {
    // It fell through to the link renderer before, so a section divider came
    // out as a clickable card with no destination and an empty hint line.
    const { html } = page([link({ kind: "header", label: "Listen", target: undefined, href: undefined })]);
    expect(html).toContain('<h2 class="section" data-block="b1">Listen</h2>');
    expect(html).not.toContain('class="block"');
  });

  it("a heading is announced to a screen reader as a heading", () => {
    const { html } = page([link({ kind: "header", label: "Shows" })]);
    expect(html).toMatch(/<h2[^>]*>Shows<\/h2>/);
  });

  it("a recognised embed renders a player and declares its host", () => {
    const { html, frameHosts } = page([
      link({ kind: "embed", target: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    ]);
    expect(html).toContain("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(html).toContain('loading="lazy"');
    expect(frameHosts).toEqual(["www.youtube-nocookie.com"]);
  });

  it("an unrecognised embed falls back to a link card rather than vanishing", () => {
    const { html, frameHosts } = page([link({ kind: "embed", target: "https://bandcamp.com/x" })]);
    expect(html).toContain('class="block"');
    expect(html).not.toContain("<iframe");
    expect(frameHosts).toEqual([]);
  });

  it("frameHosts is what was framed, not what could be", () => {
    // A page with one YouTube embed must not be permitted to frame Spotify.
    const { frameHosts } = page([
      link({ id: "b1", kind: "embed", target: "https://vimeo.com/123456" }),
      link({ id: "b2", kind: "embed", target: "https://vimeo.com/999999" }),
      link({ id: "b3" }),
    ]);
    expect(frameHosts).toEqual(["player.vimeo.com"]);
  });

  it("an embed carries no click beacon", () => {
    // The runtime listens for pointerdown on [data-block]; on an iframe that is
    // a play or a scrub, not a click-through.
    const { html } = page([link({ kind: "embed", target: "https://vimeo.com/123456" })]);
    expect(html).not.toContain('data-block="b1"');
  });

  it("a hostile label is escaped inside an iframe title", () => {
    const { html } = page([
      link({ kind: "embed", label: '"><script>alert(1)</script>', target: "https://vimeo.com/123456" }),
    ]);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("link cards and feed items open in a new tab", () => {
    const { html } = page([
      link(),
      link({ id: "b2", kind: "feed", label: "Latest", items: [{ title: "Ep 1", href: "https://example.com/ep1" }] }),
    ]);
    expect(html).toMatch(/<a class="block" href="\/r\/erin\/b1" target="_blank" rel="noopener"/);
    expect(html).toMatch(/<a class="feed-item" href="https:\/\/example\.com\/ep1" target="_blank" rel="noopener"/);
  });

  it("sameAs points at destinations, not back at our own redirector", () => {
    // Every entry used to be `/r/:handle/:id`, which is a self-reference — the
    // opposite of what sameAs is for.
    const { html } = page([link()]);
    const ld = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"),
    );
    expect(ld.sameAs).toEqual(["https://open.spotify.com/album/x"]);
  });
});

// ---------------------------------------------------------------- feed refs

describe("feed ref checks catch shape, and claim nothing more", () => {
  it("accepts the documented shapes", () => {
    expect(feedRefProblem("rss", "https://example.com/feed.xml")).toBeNull();
    expect(feedRefProblem("youtube", "UCabcdefghijklmnopqrstuv")).toBeNull();
    expect(feedRefProblem("github", "gmezurnishvili/linkbio")).toBeNull();
    expect(feedRefProblem("github", "https://github.com/a/b")).toBeNull();
    expect(feedRefProblem("spotify", "https://open.spotify.com/artist/x")).toBeNull();
    expect(feedRefProblem("twitch", "https://twitch.tv/someone")).toBeNull();
  });

  it("explains the @handle case rather than letting it fail minutes later", () => {
    expect(feedRefProblem("youtube", "@someone")).toMatch(/channel\/UC/);
    expect(feedRefProblem("youtube", "https://youtube.com/@someone")).toMatch(/channel\/UC/);
  });

  it("rejects an empty ref before the block is saved", () => {
    expect(feedRefProblem("rss", "   ")).not.toBeNull();
  });

  it("says nothing about a source it does not know", () => {
    // Drift protection: a source added on the backend must not be blocked here
    // by a client-side list that has not caught up.
    expect(feedRefProblem("newthing", "whatever")).toBeNull();
  });
});
