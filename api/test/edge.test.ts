import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const { ALL_CTX_DIMS, ctxDims, ctxVersion, decodeCtx, refClass, viewerCtx } =
  await import('../src/auth.ts');
// The producer of the hot-link value, so the edge is tested against the exact
// bytes the API writes rather than against a hand-copied format that can drift.
const { hotValue } = await import('../src/publish.ts');

/**
 * `edge/normalize.js` is a CloudFront Function: it imports the `cloudfront`
 * module, which only exists inside the edge runtime, and calls `cf.kvs()` at
 * module scope. So it cannot simply be imported here.
 *
 * Of the ways to get at it, this file uses a **loader shim**: read the source,
 * replace the two edge-only lines with a stub KeyValueStore, append an export,
 * and import the result from a `data:` URL. The alternative — regex-extracting
 * the body of `handler` — was rejected because it tests a copy of the function
 * rather than the function: `refClass`, the `GEO` table and the `WEBVIEW`
 * regex would all be re-evaluated out of context, and the slot-assembly at the
 * bottom (the exact thing this file is about) is what a bad extraction would
 * quietly drop. The shim runs the real bytes; only the two lines that reach
 * for AWS are swapped out.
 */
const EDGE = fileURLToPath(new URL('../edge/normalize.js', import.meta.url));

type EdgeModule = {
  handler(event: unknown): Promise<{ headers: Record<string, { value: string }>; statusCode?: number }>;
  refClass(ref: string): string;
};

const g = globalThis as Record<string, unknown>;

/**
 * The stub store. `normalize.js` binds `kvs` once at module scope and the ESM
 * loader caches the `data:` module, so the binding has to stay live — it reads
 * `__EDGE_STORE__` on every call rather than closing over one fixture. A
 * missing key throws, because the real KeyValueStore does and `normalize.js`
 * relies on it: both lookups sit inside their own try/catch.
 */
g.__EDGE_KVS__ = {
  async get(key: string) {
    (g.__EDGE_PROBE__ as ((k: string) => void) | undefined)?.(key);
    const store = (g.__EDGE_STORE__ ?? {}) as Record<string, string>;
    const v = store[key];
    if (v === undefined) throw new Error('KeyNotFound');
    return v;
  },
};

const edgeSource = readFileSync(EDGE, 'utf8')
  .replace(/^import cf from 'cloudfront';\s*$/m, '')
  .replace(/^const kvs = cf\.kvs\(\);\s*$/m, 'const kvs = globalThis.__EDGE_KVS__;')
  + '\nexport { handler, refClass };\n';

assert.ok(edgeSource.includes('globalThis.__EDGE_KVS__'), 'the kvs stub did not get spliced in');
assert.ok(!edgeSource.includes("from 'cloudfront'"), 'the cloudfront import did not get stripped');

const edgeModule = await import(
  `data:text/javascript;base64,${Buffer.from(edgeSource).toString('base64')}`
) as EdgeModule;

function loadEdge(store: Record<string, string>, onGet?: (key: string) => void): EdgeModule {
  g.__EDGE_STORE__ = store;
  g.__EDGE_PROBE__ = onGet;
  return edgeModule;
}

// ---------------------------------------------------------------- the viewer

/**
 * One known viewer, used for every mask. Each dimension has a distinct,
 * recognisable answer, so a token read out of the wrong slot cannot coincide
 * with the right one — which is exactly how the device-only mask got away with
 * putting its device token in the geo slot.
 */
const VIEWER = {
  'cloudfront-viewer-country': 'DE',
  'cloudfront-is-mobile-viewer': 'true',
  'cloudfront-is-tablet-viewer': 'false',
  referer: 'https://www.instagram.com/someone',
  'accept-language': 'fr-FR,fr;q=0.9',
  'user-agent': 'Mozilla/5.0 (iPhone) Instagram 300.0.0.0',
};

const EXPECTED = {
  geo: 'eu',
  device: 'mobile',
  referrer: 'ig',
  lang: 'fr',
  webview: true,
} as const;

const DIM_OF: Record<string, keyof typeof EXPECTED> = {
  g: 'geo', d: 'device', r: 'referrer', l: 'lang', w: 'webview',
};

const cfHeaders = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { value: v }]));

/** Every subset of `gdrlw`, as the mask strings `publishMask` writes. */
function allMasks(): string[] {
  const chars = [...'gdrlw'];
  const out: string[] = [];
  for (let bits = 0; bits < 32; bits++) {
    out.push(chars.filter((_, i) => bits & (1 << i)).join(''));
  }
  return out;
}

async function encode(mask: string, version: number, headers = VIEWER): Promise<string> {
  // `publishMask` deletes the key when the mask is empty, so an empty mask is
  // the absence of an entry, not an entry with an empty value.
  const store: Record<string, string> = mask ? { 'mask:erin': `v${version}|${mask}` } : {};
  const edge = loadEdge(store);
  const req = { uri: '/p/erin', headers: cfHeaders(headers) };
  const out = await edge.handler({ request: req });
  const ctx = out.headers['x-ctx'];
  assert.ok(ctx, 'the edge must always write x-ctx, even for a maskless profile');
  return ctx.value;
}

// ---------------------------------------------------------------- round trip

describe('x-ctx encode/decode', () => {
  test('the wire format is a version and five dot-separated slots', async () => {
    const raw = await encode('gd', 7);
    assert.match(raw, /^v\d+\|[^|]*$/);
    const [, body] = raw.split('|', 2);
    assert.equal(body!.split('.').length, 5, `expected five slots, got ${raw}`);
    assert.equal(ctxVersion(raw), 7);
  });

  /**
   * The test whose absence let a device-only mask read its device token as geo.
   *
   * For every one of the 32 masks: encode a viewer the edge way, decode it the
   * origin way, and check that every covered dimension came back with the right
   * value and every uncovered one came back undefined. Positional decoding is
   * only safe if the writer pads — so the assertion has to be about the slots
   * that are *not* filled as much as the ones that are.
   */
  for (const mask of allMasks()) {
    const label = mask || '(empty)';
    test(`mask ${label} round-trips every covered dimension`, async () => {
      const raw = await encode(mask, 3);
      const ctx = decodeCtx(raw) as Record<string, unknown>;

      for (const [ch, dim] of Object.entries(DIM_OF)) {
        if (mask.includes(ch)) {
          assert.equal(ctx[dim], EXPECTED[dim], `mask ${label}: ${dim} decoded as ${String(ctx[dim])}`);
        } else {
          assert.equal(ctx[dim], undefined, `mask ${label}: ${dim} should be absent, got ${String(ctx[dim])}`);
        }
      }
    });

    test(`mask ${label} reports exactly its own dimensions`, async () => {
      const raw = await encode(mask, 3);
      const dims = ctxDims(raw);
      const expected = new Set([...mask].map((ch) => DIM_OF[ch]!));
      assert.deepEqual(dims, expected, `mask ${label} reported ${[...(dims ?? [])]}`);
    });
  }

  // The single-dimension masks are where positional decoding can go wrong
  // without anything else noticing, so they get named cases of their own.
  test('a device-only mask does not put its device token in the geo slot', async () => {
    const raw = await encode('d', 3);
    assert.equal(raw, 'v3|-.m.-.-.-');
    const ctx = decodeCtx(raw);
    assert.equal(ctx.geo, undefined);
    assert.equal(ctx.device, 'mobile');
    assert.deepEqual(ctxDims(raw), new Set(['device']));
  });

  test('a webview-only mask decodes a boolean, not a string', async () => {
    const raw = await encode('w', 3);
    assert.equal(raw, 'v3|-.-.-.-.1');
    assert.equal(decodeCtx(raw).webview, true);

    const plain = { ...VIEWER, 'user-agent': 'Mozilla/5.0 (iPhone) Safari' };
    const off = await encode('w', 3, plain);
    assert.equal(off, 'v3|-.-.-.-.0');
    // False is a decision, absent is not. The two must not collapse.
    assert.equal(decodeCtx(off).webview, false);
    assert.equal(decodeCtx('v3|-.-.-.-.-').webview, undefined);
  });

  test('an unmasked profile still gets exactly one cache key per path', async () => {
    const a = await encode('', 0);
    const b = await encode('', 0, {
      ...VIEWER, 'cloudfront-viewer-country': 'JP', 'accept-language': 'ja',
    });
    assert.equal(a, 'v0|-.-.-.-.-');
    assert.equal(a, b, 'an unmasked slot must be a constant, or cardinality explodes');
    assert.deepEqual(ctxDims(a), new Set());
  });

  test('a fully masked context matches what the origin computes from raw headers', async () => {
    // The two implementations must stay byte-identical, or a response is cached
    // under a key that does not describe it.
    const raw = await encode('gdrlw', 9);
    const fromEdge = decodeCtx(raw);
    const fromHeaders = viewerCtx((n) => (VIEWER as Record<string, string>)[n.toLowerCase()]);
    assert.deepEqual(fromEdge, fromHeaders);
    assert.deepEqual(ctxDims(raw), ALL_CTX_DIMS);
  });
});

// ---------------------------------------------------------------- geo and device tables

describe('edge normalisation agrees with the origin', () => {
  const countries: Array<[string, string]> = [
    ['US', 'na'], ['CA', 'na'], ['BR', 'latam'], ['DE', 'eu'], ['GB', 'eu'],
    ['JP', 'apac'], ['IN', 'apac'], ['AE', 'mea'], ['ZZ', 'xx'], ['', 'xx'],
  ];

  for (const [country, bucket] of countries) {
    test(`${country || '(none)'} buckets to ${bucket}`, async () => {
      const raw = await encode('g', 1, { ...VIEWER, 'cloudfront-viewer-country': country });
      assert.equal(decodeCtx(raw).geo, bucket);
    });
  }

  const devices: Array<[string, string, string]> = [
    ['false', 'false', 'desktop'],
    ['true', 'false', 'mobile'],
    ['false', 'true', 'tablet'],
    // A tablet reports as both; tablet wins on each side.
    ['true', 'true', 'tablet'],
  ];

  for (const [mobile, tablet, expected] of devices) {
    test(`mobile=${mobile} tablet=${tablet} decodes to ${expected}`, async () => {
      const raw = await encode('d', 1, {
        ...VIEWER,
        'cloudfront-is-mobile-viewer': mobile,
        'cloudfront-is-tablet-viewer': tablet,
      });
      assert.equal(decodeCtx(raw).device, expected);
    });
  }

  test('referrer classes are the same on both sides', async () => {
    const referers = [
      'https://www.instagram.com/x', 'https://vm.tiktok.com/x', 'https://lnkd.in/x',
      'https://youtu.be/x', 'https://t.co/x', 'https://fb.me/x',
      'https://news.ycombinator.com/x', '',
    ];
    const edge = loadEdge({});
    for (const ref of referers) {
      const mine = refClass(ref || undefined);
      assert.equal(edge.refClass(ref), mine, `refClass disagreed on ${ref || '(none)'}`);
      const raw = await encode('r', 1, { ...VIEWER, referer: ref });
      assert.equal(decodeCtx(raw).referrer, mine);
    }
  });

  test('language is the first two characters, lowercased', async () => {
    for (const [header, expected] of [['fr-FR,fr;q=0.9', 'fr'], ['EN-GB', 'en'], ['ja', 'ja']]) {
      const raw = await encode('l', 1, { ...VIEWER, 'accept-language': header! });
      assert.equal(decodeCtx(raw).lang, expected);
    }
  });
});

// ---------------------------------------------------------------- hostile input

describe('x-ctx is origin-controlled', () => {
  test('a viewer-supplied x-ctx is discarded and replaced', async () => {
    const edge = loadEdge({ 'mask:erin': 'v4|g' });
    const out = await edge.handler({
      request: {
        uri: '/p/erin',
        headers: { ...cfHeaders(VIEWER), 'x-ctx': { value: 'v999|na.m.ig.en.1' } },
      },
    });
    // x-ctx is the only header in the cache policy, so a viewer-supplied one is
    // an unbounded supply of cache keys and an on-demand origin hit.
    assert.equal(out.headers['x-ctx']!.value, 'v4|eu.-.-.-.-');
  });

  test('a hot-path hit short-circuits to a redirect and never reaches the origin', async () => {
    const edge = loadEdge({ 'hot:erin/blk1': hotValue('https://hot.example', 307) });
    const out = await edge.handler({
      request: { uri: '/r/erin/blk1', headers: cfHeaders(VIEWER) },
    });
    assert.equal(out.statusCode, 307);
    assert.equal(out.headers['location']!.value, 'https://hot.example');
  });

  test('a destination containing a pipe survives the encoding', async () => {
    // Legal in a query string, and the reason the status leads: splitting on
    // every separator cut the target at the first one.
    const target = 'https://shop.example/x?utm=a|b&ref=c';
    const edge = loadEdge({ 'hot:erin/blk1': hotValue(target) });
    const out = await edge.handler({
      request: { uri: '/r/erin/blk1', headers: cfHeaders(VIEWER) },
    });
    assert.equal(out.statusCode, 302);
    assert.equal(out.headers['location']!.value, target);
  });

  test('a corrupt hot entry falls through to the origin rather than redirecting', async () => {
    // Better a cache miss than a 302 to an empty Location, or to a status the
    // rule engine would never emit.
    for (const bad of ['', '|', '301|https://x.example', '302|', 'https://x.example']) {
      const edge = loadEdge({ 'hot:erin/blk1': bad });
      const out = await edge.handler({
        request: { uri: '/r/erin/blk1', headers: cfHeaders(VIEWER) },
      });
      assert.ok(out.headers['x-ctx'], `"${bad}" should have fallen through to the origin`);
      assert.equal(out.statusCode, undefined);
    }
  });

  test('the page path never looks up a hot link', async () => {
    // `/p/erin` splits to a slug of '', and `hot:erin/` is a key the API never
    // writes — but asking for it is a KeyValueStore read on every page view.
    let asked = 0;
    const edge = loadEdge({}, (k) => { if (k.startsWith('hot:')) asked += 1; });
    await edge.handler({ request: { uri: '/p/erin', headers: cfHeaders(VIEWER) } });
    assert.equal(asked, 0);
  });
});

// ---------------------------------------------------------------- decoder edges

describe('decodeCtx tolerates what it may be handed', () => {
  test('a truncated body leaves the missing slots undefined', () => {
    assert.deepEqual(decodeCtx('v3|eu'), {
      geo: 'eu', device: undefined, referrer: undefined, lang: undefined, webview: undefined,
    });
  });

  test('an unknown device token is undefined rather than a guess', () => {
    assert.equal(decodeCtx('v3|-.q.-.-.-').device, undefined);
    // ...and it is still reported as a covered dimension, because the edge did
    // fold something into the key.
    assert.deepEqual(ctxDims('v3|-.q.-.-.-'), new Set(['device']));
  });

  test('a body with no version prefix still decodes by position', () => {
    assert.equal(decodeCtx('eu.m.ig.en.1').geo, 'eu');
    assert.equal(ctxVersion('eu.m.ig.en.1'), 0);
  });

  test('no x-ctx at all means the request did not come through the edge', () => {
    assert.equal(ctxDims(undefined), null);
    assert.equal(ctxDims(''), null);
  });
});
