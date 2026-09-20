/**
 * What the editor knows about feed sources.
 *
 * Deliberately only what the *form* needs: the list of sources, a hint for the
 * ref field, and a cheap shape check so a typo is caught before a round trip.
 * The adapters in `api/src/feeds/adapters.ts` are the authority — they are the
 * ones that have to resolve the ref against a real service, and this file has
 * no way to know whether a channel exists.
 *
 * The rule the backend's own `lib/rules/schema.ts` header learned the hard way
 * applies here too: a client-side copy that drifts is worse than no client-side
 * check at all. So this checks shape and nothing else, and the messages say
 * what shape is expected rather than asserting anything about validity.
 */

export const FEED_SOURCES = ["rss", "youtube", "github", "spotify", "twitch"] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

const HINTS: Record<string, string> = {
  rss: "The feed URL, e.g. https://example.com/feed.xml",
  youtube: "A channel ID (UC…), a playlist ID, or a youtube.com/channel/… URL",
  github: "owner/repo for releases, or a username for recently pushed repos",
  spotify: "An open.spotify.com link to an artist, album or playlist",
  twitch: "A channel name, e.g. twitch.tv/yourname",
};

export function feedRefHint(source: string): string {
  return HINTS[source] ?? "What to pull from this source";
}

/** A shape problem with the ref, or null. Never a claim that the ref resolves. */
export function feedRefProblem(source: string, ref: string): string | null {
  const value = ref.trim();
  if (!value) return "This can't be empty.";

  switch (source) {
    case "rss":
      return /^https?:\/\/.+/i.test(value) ? null : "A feed URL starting with https:// is expected.";
    case "youtube":
      // The one case worth catching here rather than at refresh time: an
      // @handle looks completely reasonable and cannot be resolved without an
      // API key, so the error would otherwise arrive minutes later on a block
      // that had already saved.
      if (/^@/.test(value) || /youtube\.com\/@/i.test(value)) {
        return "@handles can't be resolved. Open a video on the channel and copy the /channel/UC… URL.";
      }
      return /^UC[\w-]{20,}$/.test(value) ||
        /^(PL|UU|LL|FL|OL)[\w-]{10,}$/.test(value) ||
        /^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(value) ||
        /^https?:\/\/youtu\.be\//i.test(value)
        ? null
        : "Expected a channel ID, a playlist ID, or a youtube.com URL.";
    case "github":
      return /^[\w.-]+(\/[\w.-]+)?$/.test(value.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, ""))
        ? null
        : "Expected `owner/repo` or a username.";
    case "spotify":
      return /^(https?:\/\/open\.spotify\.com\/|spotify:)/i.test(value)
        ? null
        : "Paste the share link for an artist, album or playlist.";
    case "twitch":
      return /^[a-z0-9_]{3,25}$/i.test(value.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/$/, ""))
        ? null
        : "Expected a Twitch channel name.";
    default:
      return null;
  }
}
