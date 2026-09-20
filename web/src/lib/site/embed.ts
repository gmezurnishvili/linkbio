/**
 * Which share links become players, and what they become.
 *
 * An `embed` block used to fall through to the link renderer, so it rendered as
 * an ordinary link card and the kind meant nothing. Making it mean something
 * needs an iframe, and an iframe pointed at a creator-supplied URL is not
 * something to hand out unconditionally — so this is an allowlist, and anything
 * it does not recognise stays a link card.
 *
 * The allowlist does two jobs at once. It stops a creator framing an arbitrary
 * page inside their own profile, and it gives the route handler an exact,
 * enumerable `frame-src` — the page's CSP is `default-src 'none'`, so a frame
 * host that is not named is a frame that does not load. A wildcard `frame-src
 * https:` would have been the same as not having one.
 *
 * Sandboxing is deliberately not applied. A cross-origin iframe is already in
 * its own origin and cannot touch this document; the attributes a player needs
 * to work at all (`allow-scripts allow-same-origin`) are precisely the pair
 * that makes `sandbox` a no-op, so adding it would break the players without
 * buying anything. The allowlist plus `frame-src` is the control that holds.
 */

export type Embed = {
  /** The player URL, ready for `src`. */
  src: string;
  /** Host to name in `frame-src`. */
  host: string;
  /** Width/height, as a CSS `aspect-ratio` value. */
  ratio: string;
  /** Used for the iframe's accessible name, alongside the block's label. */
  provider: string;
};

const YT_ID = /^[\w-]{11}$/;

/** Every host that may appear in `frame-src`, for a page that has embeds. */
export const EMBED_HOSTS = [
  "www.youtube-nocookie.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "player.vimeo.com",
  "embed.music.apple.com",
] as const;

export function resolveEmbed(raw: string | undefined): Embed | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");

  // ---- YouTube ----
  // The -nocookie host is the same player without the tracking cookie set on
  // first paint, which matters on a page that has no consent banner and is not
  // going to grow one.
  if (host === "youtu.be") {
    const id = path.slice(1);
    return YT_ID.test(id) ? yt(id, u.searchParams.get("t")) : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (path === "/watch") {
      const id = u.searchParams.get("v") ?? "";
      return YT_ID.test(id) ? yt(id, u.searchParams.get("t")) : null;
    }
    const short = path.match(/^\/(?:embed|shorts|live)\/([\w-]{11})$/);
    if (short) return yt(short[1]!, u.searchParams.get("t"));
    const list = u.searchParams.get("list");
    if (path === "/playlist" && list && /^[\w-]{12,}$/.test(list)) {
      return {
        src: `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}`,
        host: "www.youtube-nocookie.com",
        ratio: "16 / 9",
        provider: "YouTube",
      };
    }
    return null;
  }

  // ---- Spotify ----
  if (host === "open.spotify.com") {
    const m = path.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)$/i);
    if (!m) return null;
    const type = m[1]!.toLowerCase();
    // A single track is a compact player; everything else is a list and needs
    // the room. Guessing wrong here is a 380px void under a one-line track.
    const tall = type !== "track" && type !== "episode";
    return {
      src: `https://open.spotify.com/embed/${type}/${m[2]}`,
      host: "open.spotify.com",
      ratio: tall ? "1 / 1" : "16 / 5",
      provider: "Spotify",
    };
  }

  // ---- SoundCloud ----
  // The widget takes the original URL as a parameter rather than an extracted
  // id, so there is nothing to parse — but that also means anything at all
  // could be passed through it, hence the host check on the way in.
  if (host === "soundcloud.com" && /^\/[\w-]+\/[\w-]+/.test(path)) {
    const target = `https://soundcloud.com${path}`;
    return {
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(target)}&color=%23ffffff&hide_related=true&show_comments=false&show_teaser=false`,
      host: "w.soundcloud.com",
      ratio: "16 / 5",
      provider: "SoundCloud",
    };
  }

  // ---- Vimeo ----
  if (host === "vimeo.com") {
    const id = path.match(/^\/(\d{6,})/);
    return id
      ? { src: `https://player.vimeo.com/video/${id[1]}`, host: "player.vimeo.com", ratio: "16 / 9", provider: "Vimeo" }
      : null;
  }

  // ---- Apple Music ----
  if (host === "music.apple.com") {
    return {
      src: `https://embed.music.apple.com${u.pathname}${u.search}`,
      host: "embed.music.apple.com",
      ratio: "1 / 1",
      provider: "Apple Music",
    };
  }

  return null;
}

function yt(id: string, start: string | null): Embed {
  const seconds = start ? Number(start.replace(/s$/, "")) : NaN;
  const qs = Number.isInteger(seconds) && seconds > 0 ? `?start=${seconds}` : "";
  return {
    src: `https://www.youtube-nocookie.com/embed/${id}${qs}`,
    host: "www.youtube-nocookie.com",
    ratio: "16 / 9",
    provider: "YouTube",
  };
}
