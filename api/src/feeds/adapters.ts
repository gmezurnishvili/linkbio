import { env } from '../env.ts';
import { fetchJson, fetchPublic, type FetchOptions, type Fetcher } from './fetch.ts';
import { childText, find, findAll, parseXml, stripTags, textOf } from './xml.ts';

/**
 * What fills a feed block.
 *
 * Every adapter is a pure function of `(ref, ctx) -> items`, with the network
 * injected, so each one is tested against a recorded payload rather than
 * against the live service. The refresher never calls `fetch` itself.
 *
 * Two failure kinds are distinguished deliberately, because they need opposite
 * handling. `FeedRefUnusable` is the creator's input being wrong — retrying it
 * every hour forever burns quota and will never succeed, so the message goes
 * back to the editor and the block backs off hard. `FeedNotConfigured` is our
 * deployment missing a credential, which is an operator problem the creator can
 * do nothing about; the block keeps whatever items it had.
 */

export type FeedItem = { title: string; subtitle?: string; href?: string };

export const FEED_SOURCES = ['youtube', 'rss', 'github', 'spotify', 'twitch'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

export class FeedRefUnusable extends Error {
  name = 'FeedRefUnusable';
}
export class FeedNotConfigured extends Error {
  name = 'FeedNotConfigured';
}

export type AdapterCtx = {
  fetch?: Fetcher;
  /** Hard ceiling on items stored per block. */
  limit: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injected so token caching can be reasoned about in tests. */
  now?: number;
};

export type Adapter = {
  source: FeedSource;
  /** Shown in the editor next to the ref field. */
  refHint: string;
  load(ref: string, ctx: AdapterCtx): Promise<FeedItem[]>;
};

const net = (ctx: AdapterCtx, extra: FetchOptions = {}): FetchOptions => ({
  fetch: ctx.fetch,
  timeoutMs: ctx.timeoutMs,
  maxBytes: ctx.maxBytes,
  ...extra,
});

// ---------------------------------------------------------------- shared

/**
 * Dates are rendered in UTC and only to the day.
 *
 * The public page is cached, and the creator's timezone is not a property of
 * the visitor looking at it. "2 hours ago" on a page with a 300-second TTL is a
 * lie for the other 298 seconds, and a local date would be wrong for most of
 * the audience. A plain UTC date is the only one that is true for everyone.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(input: string | number | undefined): string | undefined {
  if (input === undefined || input === '') return undefined;
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  // Assembled by hand rather than through Intl. The abbreviations Intl returns
  // move between ICU versions — `en-GB` gives "Sept" on Node 22 and "Sep" on
  // older builds — so a rendered page would change wording on a runtime upgrade
  // and a test pinning the string would fail on someone else's machine.
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function clean(s: string, max = 140): string {
  const t = stripTags(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** RSS 2.0 and Atom in one pass; the two differ in tag names, not in shape. */
export function parseSyndication(xml: string, limit: number): FeedItem[] {
  const doc = parseXml(xml);
  const entries = [...findAll(doc, 'item'), ...findAll(doc, 'entry')].slice(0, limit);

  return entries
    .map((e): FeedItem => {
      const title = clean(childText(e, 'title', 'media:title') || 'Untitled');
      const published = childText(e, 'pubdate', 'published', 'updated', 'dc:date');
      return {
        title,
        subtitle: formatDay(published),
        href: entryLink(e),
      };
    })
    .filter((i) => i.title.length > 0);
}

/**
 * Atom puts the URL in an attribute and RSS in element text, and an Atom entry
 * usually carries several `<link>`s of which only one is the article.
 */
function entryLink(entry: ReturnType<typeof parseXml>): string | undefined {
  for (const l of findAll(entry, 'link')) {
    const rel = l.attrs.rel;
    if (rel && rel !== 'alternate') continue;
    const href = l.attrs.href ?? textOf(l);
    if (href) return href.trim();
  }
  const guid = find(entry, 'guid');
  const raw = guid && guid.attrs.ispermalink !== 'false' ? textOf(guid) : '';
  return raw.startsWith('http') ? raw : undefined;
}

// ---------------------------------------------------------------- rss

const rss: Adapter = {
  source: 'rss',
  refHint: 'The feed URL, e.g. https://example.com/feed.xml',
  async load(ref, ctx) {
    const url = ref.trim();
    if (!/^https?:\/\//i.test(url)) throw new FeedRefUnusable('a feed URL starting with https:// is required');
    const xml = await fetchPublic(url, net(ctx, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' } }));
    const items = parseSyndication(xml, ctx.limit);
    if (items.length === 0) throw new FeedRefUnusable('that URL parsed, but contains no feed items');
    return items;
  },
};

// ---------------------------------------------------------------- youtube

/**
 * YouTube publishes an Atom feed per channel and per playlist, with no key and
 * no quota. The Data API would need one, and would need the operator to hold it
 * — the feed is both cheaper and one less credential.
 *
 * The cost is that `@handle` cannot be resolved without either the API or
 * scraping the channel page, and neither is worth it. That case is reported
 * back to the creator with the fix, which is a thing they can copy off the
 * channel's own page.
 */
const YT_HOST = 'www.youtube.com';

export function youtubeFeedUrl(ref: string): string {
  const r = ref.trim();
  if (/^https?:\/\//i.test(r)) {
    let u: URL;
    try { u = new URL(r); } catch { throw new FeedRefUnusable('that does not look like a URL'); }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname) && u.hostname.toLowerCase() !== 'youtu.be') {
      throw new FeedRefUnusable('that is not a youtube.com URL');
    }
    if (u.pathname === '/feeds/videos.xml') return `https://${YT_HOST}/feeds/videos.xml${u.search}`;
    const list = u.searchParams.get('list');
    if (list) return playlistFeed(list);
    const inPath = u.pathname.match(/\/channel\/(UC[\w-]{20,})/i);
    if (inPath) return channelFeed(inPath[1]!);
    if (/\/@[^/]+/.test(u.pathname)) throw new FeedRefUnusable(handleHint);
    throw new FeedRefUnusable('paste the channel URL (the one containing /channel/UC…) or the channel ID');
  }
  if (/^UC[\w-]{20,}$/.test(r)) return channelFeed(r);
  if (/^(PL|UU|LL|FL|OL)[\w-]{10,}$/.test(r)) return playlistFeed(r);
  if (r.startsWith('@')) throw new FeedRefUnusable(handleHint);
  throw new FeedRefUnusable('expected a channel ID starting UC…, a playlist ID, or a youtube.com URL');
}

const handleHint =
  '@handles cannot be resolved without an API key. Open the channel, click a video, and copy the /channel/UC… URL.';

const channelFeed = (id: string) => `https://${YT_HOST}/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
const playlistFeed = (id: string) => `https://${YT_HOST}/feeds/videos.xml?playlist_id=${encodeURIComponent(id)}`;

const youtube: Adapter = {
  source: 'youtube',
  refHint: 'A channel ID (UC…), a playlist ID, or a youtube.com/channel/… URL',
  async load(ref, ctx) {
    const xml = await fetchPublic(youtubeFeedUrl(ref), net(ctx, { allowHosts: [YT_HOST] }));
    const items = parseSyndication(xml, ctx.limit);
    if (items.length === 0) throw new FeedRefUnusable('that channel or playlist has no public videos');
    return items;
  },
};

// ---------------------------------------------------------------- github

type GhRelease = { name?: string | null; tag_name?: string; html_url?: string; published_at?: string; draft?: boolean };
type GhRepo = { full_name?: string; name?: string; description?: string | null; html_url?: string; pushed_at?: string; fork?: boolean };

const GH_HOST = 'api.github.com';

const github: Adapter = {
  source: 'github',
  refHint: 'owner/repo for releases, or a username for recently pushed repos',
  async load(ref, ctx) {
    const r = ref.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(r)) throw new FeedRefUnusable('expected `owner/repo` or a username');

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // Unauthenticated is 60 requests an hour per IP, shared across every
      // block in the fleet on a warm Lambda. A token raises it to 5,000 and is
      // the difference between this working and working in development only.
      ...(env.githubToken ? { authorization: `Bearer ${env.githubToken}` } : {}),
    };
    const opts = net(ctx, { headers, allowHosts: [GH_HOST] });
    const n = Math.min(ctx.limit, 20);

    if (r.includes('/')) {
      const releases = await fetchJson<GhRelease[]>(
        `https://${GH_HOST}/repos/${r}/releases?per_page=${n}`, opts,
      );
      const items = releases
        .filter((x) => !x.draft)
        .slice(0, ctx.limit)
        .map((x): FeedItem => ({
          title: clean(x.name || x.tag_name || 'Release'),
          subtitle: formatDay(x.published_at),
          href: x.html_url,
        }));
      if (items.length === 0) throw new FeedRefUnusable('that repository has no published releases');
      return items;
    }

    const repos = await fetchJson<GhRepo[]>(
      `https://${GH_HOST}/users/${r}/repos?sort=pushed&per_page=${n}`, opts,
    );
    const items = repos
      .filter((x) => !x.fork)
      .slice(0, ctx.limit)
      .map((x): FeedItem => ({
        title: clean(x.name || x.full_name || 'Repository'),
        subtitle: x.description ? clean(x.description, 90) : formatDay(x.pushed_at),
        href: x.html_url,
      }));
    if (items.length === 0) throw new FeedRefUnusable('that user has no public non-fork repositories');
    return items;
  },
};

// ---------------------------------------------------------------- oauth helper

/**
 * Client-credentials tokens for Spotify and Twitch, cached per process.
 *
 * Both are ordinary app tokens with no user context, so one per container is
 * correct and re-minting per block would be the bulk of the refresher's
 * requests. Expiry is deliberately trimmed by a minute: a token that expires
 * mid-run produces a 401 that looks like a broken ref.
 */
type Token = { value: string; expiresAt: number };
const tokens = new Map<string, Token>();

async function clientCredentials(
  key: string,
  request: () => Promise<{ access_token?: string; expires_in?: number }>,
  now: number,
): Promise<string> {
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const res = await request();
  if (!res.access_token) throw new FeedNotConfigured(`${key}: the credential exchange returned no token`);
  tokens.set(key, {
    value: res.access_token,
    expiresAt: now + Math.max(60, (res.expires_in ?? 3600) - 60) * 1000,
  });
  return res.access_token;
}

/** Test seam: the token cache is process-global, so a test has to be able to clear it. */
export function resetTokenCache(): void {
  tokens.clear();
}

// ---------------------------------------------------------------- spotify

type SpTrack = { name?: string; external_urls?: { spotify?: string }; album?: { name?: string; release_date?: string }; artists?: { name?: string }[] };
type SpPlaylistItem = { track?: SpTrack | null; added_at?: string };

const SP_API = 'api.spotify.com';
const SP_AUTH = 'accounts.spotify.com';

export function spotifyRef(ref: string): { type: 'artist' | 'playlist' | 'album'; id: string } {
  const r = ref.trim();
  const uri = r.match(/^spotify:(artist|playlist|album):([A-Za-z0-9]+)$/);
  if (uri) return { type: uri[1] as 'artist', id: uri[2]! };
  const url = r.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(artist|playlist|album)\/([A-Za-z0-9]+)/i);
  if (url) return { type: url[1]!.toLowerCase() as 'artist', id: url[2]! };
  throw new FeedRefUnusable('paste the share link for an artist, album or playlist');
}

const spotify: Adapter = {
  source: 'spotify',
  refHint: 'An open.spotify.com link to an artist, album or playlist',
  async load(ref, ctx) {
    const { type, id } = spotifyRef(ref);
    if (!env.spotifyClientId || !env.spotifyClientSecret) {
      throw new FeedNotConfigured('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not set');
    }
    const now = ctx.now ?? Date.now();
    const basic = Buffer.from(`${env.spotifyClientId}:${env.spotifyClientSecret}`).toString('base64');
    const token = await clientCredentials('spotify', () => fetchJson(
      `https://${SP_AUTH}/api/token`,
      net(ctx, {
        method: 'POST',
        allowHosts: [SP_AUTH],
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      }),
    ), now);

    const opts = net(ctx, { headers: { authorization: `Bearer ${token}` }, allowHosts: [SP_API] });
    const n = Math.min(ctx.limit, 20);

    if (type === 'artist') {
      // `market` is required and the endpoint has no global variant, so the
      // track list is the US one for every visitor. A per-country list would
      // need geo in the cache key for a block that has no rule asking for it.
      const r = await fetchJson<{ tracks?: SpTrack[] }>(
        `https://${SP_API}/v1/artists/${id}/top-tracks?market=US`, opts,
      );
      return (r.tracks ?? []).slice(0, ctx.limit).map(trackItem);
    }
    if (type === 'album') {
      const r = await fetchJson<{ items?: SpTrack[] }>(
        `https://${SP_API}/v1/albums/${id}/tracks?limit=${n}`, opts,
      );
      return (r.items ?? []).slice(0, ctx.limit).map(trackItem);
    }
    const r = await fetchJson<{ items?: SpPlaylistItem[] }>(
      `https://${SP_API}/v1/playlists/${id}/tracks?limit=${n}&fields=items(added_at,track(name,external_urls,artists(name),album(name,release_date)))`,
      opts,
    );
    return (r.items ?? [])
      .map((i) => i.track)
      .filter((t): t is SpTrack => Boolean(t?.name))
      .slice(0, ctx.limit)
      .map(trackItem);
  },
};

function trackItem(t: SpTrack): FeedItem {
  const artists = (t.artists ?? []).map((a) => a.name).filter(Boolean).join(', ');
  return {
    title: clean(t.name ?? 'Track'),
    subtitle: clean(artists || t.album?.name || '', 90) || formatDay(t.album?.release_date),
    href: t.external_urls?.spotify,
  };
}

// ---------------------------------------------------------------- twitch

type TwUser = { id?: string; display_name?: string };
type TwVideo = { title?: string; url?: string; published_at?: string; duration?: string };

const TW_API = 'api.twitch.tv';
const TW_AUTH = 'id.twitch.tv';

const twitch: Adapter = {
  source: 'twitch',
  refHint: 'A channel name, e.g. twitch.tv/yourname',
  async load(ref, ctx) {
    const login = ref.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/$/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new FeedRefUnusable('expected a Twitch channel name');
    if (!env.twitchClientId || !env.twitchClientSecret) {
      throw new FeedNotConfigured('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are not set');
    }
    const now = ctx.now ?? Date.now();
    const token = await clientCredentials('twitch', () => fetchJson(
      `https://${TW_AUTH}/oauth2/token`,
      net(ctx, {
        method: 'POST',
        allowHosts: [TW_AUTH],
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.twitchClientId,
          client_secret: env.twitchClientSecret,
          grant_type: 'client_credentials',
        }).toString(),
      }),
    ), now);

    const opts = net(ctx, {
      headers: { authorization: `Bearer ${token}`, 'client-id': env.twitchClientId },
      allowHosts: [TW_API],
    });

    const users = await fetchJson<{ data?: TwUser[] }>(
      `https://${TW_API}/helix/users?login=${encodeURIComponent(login)}`, opts,
    );
    const userId = users.data?.[0]?.id;
    if (!userId) throw new FeedRefUnusable(`no Twitch channel called ${login}`);

    const videos = await fetchJson<{ data?: TwVideo[] }>(
      `https://${TW_API}/helix/videos?user_id=${userId}&first=${Math.min(ctx.limit, 20)}&sort=time&type=archive`,
      opts,
    );
    const items = (videos.data ?? []).slice(0, ctx.limit).map((v): FeedItem => ({
      title: clean(v.title ?? 'Stream'),
      subtitle: [formatDay(v.published_at), v.duration].filter(Boolean).join(' · ') || undefined,
      href: v.url,
    }));
    if (items.length === 0) throw new FeedRefUnusable('that channel has no past broadcasts saved');
    return items;
  },
};

// ---------------------------------------------------------------- registry

export const ADAPTERS: Record<FeedSource, Adapter> = { youtube, rss, github, spotify, twitch };

export function adapterFor(source: string): Adapter {
  const a = ADAPTERS[source as FeedSource];
  if (!a) throw new FeedRefUnusable(`unknown feed source "${source}"`);
  return a;
}
