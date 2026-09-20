import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const { parseXml, findAll, childText, textOf, decodeEntities, stripTags } =
  await import('../src/feeds/xml.ts');
const { fetchPublic, FeedFetchError } = await import('../src/feeds/fetch.ts');
const {
  ADAPTERS, FeedNotConfigured, FeedRefUnusable, parseSyndication, resetTokenCache,
  spotifyRef, youtubeFeedUrl, formatDay,
} = await import('../src/feeds/adapters.ts');
const { refreshBlock, refreshDue, mapLimit } = await import('../src/feeds/refresh.ts');
const { nextFeedDueAt, shardFor } = await import('../src/domain/types.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');
import type { Block } from '../src/domain/types.ts';

// ---------------------------------------------------------------- fixtures

/**
 * A fetch stand-in.
 *
 * Adapters are only ever handed this, never the global, so a test that forgets
 * to register a route gets a loud 404 instead of a live network call that
 * passes on a laptop and fails in CI.
 */
function fakeFetch(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const hit = routes[url];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body ?? '', { status: hit.status ?? 200, headers: hit.headers });
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Channel</title>
  <item>
    <title><![CDATA[Tour dates & <b>tickets</b>]]></title>
    <link>https://example.com/one</link>
    <pubDate>Fri, 04 Oct 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second &amp; last</title>
    <guid isPermaLink="true">https://example.com/two</guid>
    <pubDate>Sat, 11 Oct 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>New single</title>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://example.com/video"/>
    <published>2026-09-01T10:00:00+00:00</published>
  </entry>
</feed>`;

// ---------------------------------------------------------------- xml

describe('the XML reader', () => {
  test('CDATA is text, not markup', () => {
    const doc = parseXml('<a><t><![CDATA[<b>raw & wild</b>]]></t></a>');
    assert.equal(childText(doc, 't'), '<b>raw & wild</b>');
    // The CDATA payload must not have produced a <b> element.
    assert.equal(findAll(doc, 'b').length, 0);
  });

  test('numeric and named entities decode, unknown ones are left alone', () => {
    assert.equal(decodeEntities('a &amp; b &#65; &#x42; &nope;'), 'a & b A B &nope;');
  });

  test('a surrogate or out-of-range code point is left as written', () => {
    // String.fromCodePoint throws on these; a feed with one should not take the
    // whole refresh down.
    assert.equal(decodeEntities('&#xD800; &#x110000;'), '&#xD800; &#x110000;');
  });

  test('a quoted attribute may contain the tag terminator', () => {
    const doc = parseXml('<link href="https://x.test/?a=1>2" rel="alternate"/><p>after</p>');
    assert.equal(findAll(doc, 'link')[0]!.attrs.href, 'https://x.test/?a=1>2');
    assert.equal(childText(doc, 'p'), 'after');
  });

  test('a stray close tag is dropped rather than closing the current element', () => {
    const doc = parseXml('<a><b>one</i>two</b></a>');
    assert.equal(childText(doc, 'b'), 'onetwo');
  });

  test('an unterminated tag ends the document instead of throwing', () => {
    const doc = parseXml('<a><b>fine</b><c attr="oops');
    assert.equal(childText(doc, 'b'), 'fine');
  });

  test('comments and the doctype contribute nothing', () => {
    const doc = parseXml('<!DOCTYPE x><!-- <item>ghost</item> --><a>real</a>');
    assert.equal(findAll(doc, 'item').length, 0);
    assert.equal(textOf(doc), 'real');
  });

  test('stripTags flattens embedded HTML in a description', () => {
    assert.equal(stripTags('<p>Hello <em>there</em></p>'), 'Hello there');
  });
});

describe('syndication parsing', () => {
  test('RSS items carry title, link and a UTC day', () => {
    const items = parseSyndication(RSS, 10);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      title: 'Tour dates & tickets',
      subtitle: '4 Oct 2026',
      href: 'https://example.com/one',
    });
    // A permalink guid stands in for a missing <link>.
    assert.equal(items[1]!.href, 'https://example.com/two');
  });

  test('an Atom entry prefers the alternate link over rel="self"', () => {
    const items = parseSyndication(ATOM, 10);
    assert.equal(items[0]!.href, 'https://example.com/video');
  });

  test('the limit is applied to items, not to bytes', () => {
    assert.equal(parseSyndication(RSS, 1).length, 1);
  });

  test('month abbreviations do not move with the ICU version', () => {
    // Intl's `en-GB` short month is "Sept" on Node 22 and "Sep" on older
    // builds, which would change a live page's wording on a runtime bump.
    assert.equal(formatDay('2026-09-01T00:00:00Z'), '1 Sep 2026');
  });

  test('dates are rendered in UTC, so every visitor sees the same one', () => {
    // The page is cached and shared; a creator-local date would be wrong for
    // most of the audience and would have to enter the cache key to be right.
    assert.equal(formatDay('2026-01-01T23:30:00Z'), '1 Jan 2026');
  });
});

// ---------------------------------------------------------------- fetcher

describe('the fetcher refuses what SafeUrl would', () => {
  test('a private target is rejected before any request is made', async () => {
    const f = fakeFetch({});
    await assert.rejects(
      () => fetchPublic('http://169.254.169.254/latest/meta-data/', { fetch: f }),
      FeedFetchError,
    );
    assert.equal(f.calls.length, 0);
  });

  test('a redirect into link-local space is caught on the second hop', async () => {
    // This is the whole reason redirects are followed by hand. `redirect:
    // "follow"` would have validated the public first hop and then fetched the
    // metadata service without ever consulting the check again.
    const f = fakeFetch({
      'https://feed.example/rss': { status: 302, headers: { location: 'http://169.254.169.254/' } },
    });
    await assert.rejects(
      () => fetchPublic('https://feed.example/rss', { fetch: f }),
      /private or non-http/,
    );
    assert.equal(f.calls.length, 1);
  });

  test('a relative redirect resolves against the hop it came from', async () => {
    const f = fakeFetch({
      'https://feed.example/a': { status: 301, headers: { location: '/b' } },
      'https://feed.example/b': { body: 'arrived' },
    });
    assert.equal(await fetchPublic('https://feed.example/a', { fetch: f }), 'arrived');
  });

  test('a redirect loop terminates', async () => {
    const f = fakeFetch({
      'https://feed.example/a': { status: 302, headers: { location: 'https://feed.example/a' } },
    });
    await assert.rejects(() => fetchPublic('https://feed.example/a', { fetch: f }), /redirects/);
  });

  test('a body over the cap is refused rather than buffered', async () => {
    const f = fakeFetch({ 'https://feed.example/big': { body: 'x'.repeat(5000) } });
    await assert.rejects(
      () => fetchPublic('https://feed.example/big', { fetch: f, maxBytes: 1000 }),
      /cap/,
    );
  });

  test('a declared content-length over the cap short-circuits the read', async () => {
    const f = fakeFetch({
      'https://feed.example/big': { body: 'x', headers: { 'content-length': '999999999' } },
    });
    await assert.rejects(() => fetchPublic('https://feed.example/big', { fetch: f, maxBytes: 1000 }), /cap/);
  });

  test('a non-2xx is an error, not an empty feed', async () => {
    const f = fakeFetch({ 'https://feed.example/rss': { status: 500, body: 'boom' } });
    await assert.rejects(() => fetchPublic('https://feed.example/rss', { fetch: f }), /500/);
  });

  test('allowHosts pins an adapter to the API it thinks it is calling', async () => {
    const f = fakeFetch({ 'https://elsewhere.test/x': { body: 'ok' } });
    await assert.rejects(
      () => fetchPublic('https://elsewhere.test/x', { fetch: f, allowHosts: ['api.github.com'] }),
      /unexpected host/,
    );
  });
});

// ---------------------------------------------------------------- adapters

describe('the rss adapter', () => {
  test('parses a feed into items', async () => {
    const f = fakeFetch({ 'https://blog.example/feed.xml': { body: RSS } });
    const items = await ADAPTERS.rss.load('https://blog.example/feed.xml', { limit: 8, fetch: f });
    assert.equal(items.length, 2);
  });

  test('a ref that is not a URL is the creator\'s problem, not a transient one', async () => {
    await assert.rejects(
      () => ADAPTERS.rss.load('my blog', { limit: 8, fetch: fakeFetch({}) }),
      FeedRefUnusable,
    );
  });

  test('a document with no items is reported rather than stored as empty', async () => {
    // Storing zero items renders the block as nothing at all, which is
    // indistinguishable from the block never having saved.
    const f = fakeFetch({ 'https://blog.example/feed.xml': { body: '<rss><channel/></rss>' } });
    await assert.rejects(
      () => ADAPTERS.rss.load('https://blog.example/feed.xml', { limit: 8, fetch: f }),
      FeedRefUnusable,
    );
  });
});

describe('the youtube adapter resolves refs without an API key', () => {
  test('channel IDs, playlist IDs and channel URLs all map to the Atom feed', () => {
    const uc = 'UCabcdefghijklmnopqrstuv';
    assert.equal(youtubeFeedUrl(uc), `https://www.youtube.com/feeds/videos.xml?channel_id=${uc}`);
    assert.equal(
      youtubeFeedUrl(`https://www.youtube.com/channel/${uc}/videos`),
      `https://www.youtube.com/feeds/videos.xml?channel_id=${uc}`,
    );
    assert.match(youtubeFeedUrl('PLabcdefghijklmn'), /playlist_id=PLabcdefghijklmn/);
    assert.match(
      youtubeFeedUrl('https://www.youtube.com/watch?v=x&list=PLzzzzzzzzzzz'),
      /playlist_id=PLzzzzzzzzzzz/,
    );
  });

  test('an @handle explains the fix instead of failing opaquely', () => {
    // Resolving one needs the Data API or a page scrape. Saying so, with the
    // thing to copy, beats a silent empty block.
    assert.throws(() => youtubeFeedUrl('@someone'), /channel\/UC/);
    assert.throws(() => youtubeFeedUrl('https://www.youtube.com/@someone'), /channel\/UC/);
  });

  test('a non-YouTube URL is rejected rather than fetched', () => {
    assert.throws(() => youtubeFeedUrl('https://vimeo.com/x'), FeedRefUnusable);
  });

  test('the feed is read from youtube.com and nowhere else', async () => {
    const uc = 'UCabcdefghijklmnopqrstuv';
    const f = fakeFetch({ [`https://www.youtube.com/feeds/videos.xml?channel_id=${uc}`]: { body: ATOM } });
    const items = await ADAPTERS.youtube.load(uc, { limit: 8, fetch: f });
    assert.equal(items[0]!.title, 'New single');
  });
});

describe('the github adapter', () => {
  test('owner/repo reads releases', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/gmezurnishvili/linkbio/releases?per_page=8': {
        body: JSON.stringify([
          { name: 'v1.2.0', html_url: 'https://github.com/x/releases/v1.2.0', published_at: '2026-09-01T00:00:00Z' },
          { name: 'draft', draft: true, html_url: 'https://x', published_at: '2026-09-02T00:00:00Z' },
        ]),
      },
    });
    const items = await ADAPTERS.github.load('gmezurnishvili/linkbio', { limit: 8, fetch: f });
    assert.deepEqual(items, [
      { title: 'v1.2.0', subtitle: '1 Sep 2026', href: 'https://github.com/x/releases/v1.2.0' },
    ]);
  });

  test('a bare username reads recently pushed non-fork repos', async () => {
    const f = fakeFetch({
      'https://api.github.com/users/gmezurnishvili/repos?sort=pushed&per_page=8': {
        body: JSON.stringify([
          { name: 'linkbio', description: 'Context-aware link in bio', html_url: 'https://github.com/g/linkbio' },
          { name: 'someone-elses', fork: true, html_url: 'https://github.com/g/fork' },
        ]),
      },
    });
    const items = await ADAPTERS.github.load('gmezurnishvili', { limit: 8, fetch: f });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.subtitle, 'Context-aware link in bio');
  });

  test('a github.com URL is accepted as shorthand', async () => {
    const f = fakeFetch({
      'https://api.github.com/repos/a/b/releases?per_page=8': {
        body: JSON.stringify([{ tag_name: 'v0.1', html_url: 'https://github.com/a/b' }]),
      },
    });
    const items = await ADAPTERS.github.load('https://github.com/a/b', { limit: 8, fetch: f });
    assert.equal(items[0]!.title, 'v0.1');
  });
});

describe('the credentialled adapters', () => {
  beforeEach(() => resetTokenCache());

  test('spotify says it is unconfigured rather than blaming the ref', async () => {
    // A missing operator credential must not look like a creator mistake: the
    // refresher counts the two differently and only one of them backs off.
    await assert.rejects(
      () => ADAPTERS.spotify.load('https://open.spotify.com/artist/abc123', { limit: 8, fetch: fakeFetch({}) }),
      FeedNotConfigured,
    );
  });

  test('twitch says the same', async () => {
    await assert.rejects(
      () => ADAPTERS.twitch.load('somechannel', { limit: 8, fetch: fakeFetch({}) }),
      FeedNotConfigured,
    );
  });

  test('a bad spotify ref is caught before the credential check', async () => {
    assert.throws(() => spotifyRef('https://open.spotify.com/track/x'), FeedRefUnusable);
    assert.deepEqual(spotifyRef('spotify:artist:abc'), { type: 'artist', id: 'abc' });
    assert.deepEqual(
      spotifyRef('https://open.spotify.com/intl-de/playlist/xyz?si=1'),
      { type: 'playlist', id: 'xyz' },
    );
  });
});

// ---------------------------------------------------------------- scheduling

function feedBlock(over: Partial<Block> = {}): Block {
  const now = Date.now();
  return {
    id: 'blk_feed', profileId: 'p1', rank: 'a0', kind: 'feed', label: 'Tour dates',
    hidden: false, rules: [], feed: { source: 'rss', ref: 'https://blog.example/feed.xml', ttlSeconds: 3600 },
    createdAt: now, updatedAt: now, ...over,
  };
}

describe('the refresh schedule', () => {
  test('a healthy block comes due one TTL after its last attempt', () => {
    const b = feedBlock({ feedAttemptedAt: 1_000_000, feedFailures: 0 });
    assert.equal(nextFeedDueAt(b), 1_000_000 + 3_600_000);
  });

  test('failures double the interval up to a ceiling', () => {
    const at = (n: number) => nextFeedDueAt(feedBlock({ feedAttemptedAt: 0, feedFailures: n }));
    assert.equal(at(1), 2 * 3_600_000);
    assert.equal(at(4), 16 * 3_600_000);
    // Capped, so a long-dead feed settles at roughly daily rather than drifting
    // to never.
    assert.equal(at(50), 16 * 3_600_000);
  });

  test('the clock runs from the attempt, not the success', () => {
    // Keying off the last *success* leaves a failing block permanently due, and
    // it gets retried on every single scheduled run forever.
    const b = feedBlock({ feedRefreshedAt: 0, feedAttemptedAt: 5_000_000, feedFailures: 0 });
    assert.equal(nextFeedDueAt(b), 5_000_000 + 3_600_000);
  });
});

describe('refreshBlock', () => {
  test('a success stores items and clears the error', async () => {
    const repo = new MemoryRepo();
    const b = feedBlock({ feedFailures: 3, feedError: 'old news' });
    await repo.putBlock(b);

    const out = await refreshBlock(repo, b, {
      now: 5_000,
      ctx: { fetch: fakeFetch({ 'https://blog.example/feed.xml': { body: RSS } }) },
    });

    assert.equal(out.status, 'ok');
    const saved = (await repo.getBlock('p1', 'blk_feed'))!;
    assert.equal(saved.items?.length, 2);
    assert.equal(saved.feedRefreshedAt, 5_000);
    assert.equal(saved.feedAttemptedAt, 5_000);
    assert.equal(saved.feedFailures, 0);
    // Not "set to undefined": the document client drops undefined attributes,
    // so the stored row must not carry the key at all.
    assert.ok(!('feedError' in saved), 'a cleared error must not linger as a key');
  });

  test('a failure counts, records why, and keeps the items it had', async () => {
    const repo = new MemoryRepo();
    const b = feedBlock({ items: [{ title: 'stale but real' }], feedRefreshedAt: 100 });
    await repo.putBlock(b);

    const out = await refreshBlock(repo, b, {
      now: 9_000,
      ctx: { fetch: fakeFetch({ 'https://blog.example/feed.xml': { status: 503 } }) },
    });

    assert.equal(out.status, 'failed');
    const saved = (await repo.getBlock('p1', 'blk_feed'))!;
    // A creator's page showing last week's tour dates beats it showing nothing.
    assert.deepEqual(saved.items, [{ title: 'stale but real' }]);
    assert.equal(saved.feedRefreshedAt, 100, 'a failed fetch is not a refresh');
    assert.equal(saved.feedAttemptedAt, 9_000);
    assert.equal(saved.feedFailures, 1);
    assert.match(saved.feedError!, /503/);
  });

  test('a missing credential does not count against the block', async () => {
    const repo = new MemoryRepo();
    const b = feedBlock({ feed: { source: 'spotify', ref: 'spotify:artist:abc', ttlSeconds: 3600 } });
    await repo.putBlock(b);

    const out = await refreshBlock(repo, b, { now: 7_000, ctx: { fetch: fakeFetch({}) } });

    assert.equal(out.status, 'unconfigured');
    const saved = (await repo.getBlock('p1', 'blk_feed'))!;
    assert.equal(saved.feedFailures, undefined, 'an operator problem is not the creator\'s failure count');
    assert.equal(saved.feedError, undefined);
    assert.equal(saved.feedAttemptedAt, 7_000, 'but it still has to leave the due window');
  });

  test('a block deleted mid-refresh is not resurrected', async () => {
    const repo = new MemoryRepo();
    const b = feedBlock();
    // Never written: the index handed us a row that has since gone.
    const out = await refreshBlock(repo, b, {
      now: 1, ctx: { fetch: fakeFetch({ 'https://blog.example/feed.xml': { body: RSS } }) },
    });
    assert.equal(out.status, 'ok');
    assert.equal(await repo.getBlock('p1', 'blk_feed'), null);
  });

  test('a block whose feed config was removed leaves the index quietly', async () => {
    const repo = new MemoryRepo();
    const b = feedBlock({ feed: undefined });
    await repo.putBlock(b);
    const out = await refreshBlock(repo, b, { now: 3, ctx: { fetch: fakeFetch({}) } });
    assert.equal(out.status, 'ok');
    assert.equal((await repo.getBlock('p1', 'blk_feed'))!.feedAttemptedAt, 3);
  });
});

describe('refreshDue', () => {
  test('walks every shard and refreshes only what is due', async () => {
    const repo = new MemoryRepo();
    const now = 10_000_000;
    // Due: never fetched. Not due: fetched a minute ago on an hourly TTL.
    await repo.putBlock(feedBlock({ id: 'due_1' }));
    await repo.putBlock(feedBlock({ id: 'due_2' }));
    await repo.putBlock(feedBlock({ id: 'fresh', feedAttemptedAt: now - 60_000 }));
    await repo.putBlock(feedBlock({ id: 'not_a_feed', kind: 'link', target: 'https://x.test' }));

    const summary = await refreshDue(repo, {
      now,
      ctx: { fetch: fakeFetch({ 'https://blog.example/feed.xml': { body: RSS } }) },
    });

    assert.equal(summary.scanned, 2);
    assert.equal(summary.ok, 2);
    assert.deepEqual(summary.outcomes.map((o) => o.blockId).sort(), ['due_1', 'due_2']);
    assert.equal((await repo.getBlock('p1', 'fresh'))!.feedAttemptedAt, now - 60_000);
  });

  test('every block lands in exactly one shard', async () => {
    // The memory repo filters by shard the way DynamoDB partitions by it. When
    // it did not, a ten-shard walk processed every block ten times locally and
    // once in production — and only one of those was under test.
    const repo = new MemoryRepo();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (const id of ids) await repo.putBlock(feedBlock({ id }));

    const seen: string[] = [];
    for (let shard = 0; shard < 10; shard += 1) {
      seen.push(...(await repo.dueForRefresh(shard, 10_000_000, 100)).map((b) => b.id));
    }
    assert.deepEqual(seen.slice().sort(), ids.slice().sort());
    for (const id of ids) assert.ok(shardFor(id) >= 0 && shardFor(id) < 10);
  });

  test('one broken feed does not stop the batch', async () => {
    const repo = new MemoryRepo();
    await repo.putBlock(feedBlock({ id: 'good' }));
    await repo.putBlock(feedBlock({
      id: 'bad', feed: { source: 'rss', ref: 'https://down.example/feed.xml', ttlSeconds: 3600 },
    }));

    const summary = await refreshDue(repo, {
      now: 10_000_000,
      ctx: { fetch: fakeFetch({ 'https://blog.example/feed.xml': { body: RSS } }) },
    });

    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 1);
  });
});

describe('mapLimit', () => {
  test('never runs more than the limit at once, and preserves order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  test('an empty list does not hang', async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
  });
});
