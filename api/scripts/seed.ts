/**
 * A demo page, built against the running API over HTTP.
 *
 * Until now the only seeded data in the repository lived inside
 * `web/dev/mock-api.mjs`, which meant the easiest way to see the product was
 * also the one path that does not exercise the real evaluator — and the mock
 * is documented as optimistic about exactly the things worth judging (it
 * reports `cacheable` unconditionally and finds `sMaxAge` by scanning forward a
 * minute at a time). Against the real backend every run started from an empty
 * signup, so the simulator had nothing to simulate.
 *
 * This talks to the API the same way the dashboard does: register, create,
 * add blocks, attach rules, publish. Nothing here reaches into a repository,
 * so it works against `memory` and `dynamo` alike.
 *
 *   npm run seed                      # http://localhost:8787
 *   API=https://… npm run seed        # somewhere else
 *   HANDLE=demo EMAIL=me@example.com npm run seed
 *
 * Re-running it is safe: an existing account is signed into rather than
 * re-registered, and a handle that is already taken by that account is reused.
 */

const API = process.env.API ?? 'http://localhost:8787';
const EMAIL = process.env.EMAIL ?? 'demo@linkbio.local';
const PASSWORD = process.env.PASSWORD ?? 'demo-password-1234';
const HANDLE = (process.env.HANDLE ?? 'giorgi').toLowerCase();

type Json = Record<string, unknown>;

let token = '';
/** The profile version, carried as If-Match the way the dashboard carries it. */
let version = 0;

async function call(method: string, path: string, body?: unknown, opts: { match?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.match) headers['if-match'] = String(version);

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) {
    const detail = String(parsed.detail ?? parsed.message ?? text);
    throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${detail}`), {
      status: res.status,
      body: parsed,
    });
  }
  // Every mutation answers with the new version; holding it is what keeps the
  // next If-Match from being stale.
  if (typeof parsed.version === 'number') version = parsed.version;
  return parsed;
}

/** Register, or sign in if the account is already there from a previous run. */
async function authenticate(): Promise<void> {
  try {
    const out = await call('POST', '/v1/auth/register', { email: EMAIL, password: PASSWORD });
    token = String(out.accessToken);
    console.log(`  registered ${EMAIL}`);
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e;
    const out = await call('POST', '/v1/auth/token', { email: EMAIL, password: PASSWORD });
    token = String(out.accessToken);
    console.log(`  signed in as ${EMAIL}`);
  }
}

async function profile(): Promise<string> {
  const me = (await call('GET', '/v1/me')) as { profiles: { id: string; handle: string }[] };
  const existing = me.profiles.find((p) => p.handle === HANDLE);
  if (existing) {
    const full = (await call('GET', `/v1/profiles/${existing.id}`)) as { version: number };
    version = full.version;
    console.log(`  reusing /${HANDLE}`);
    return existing.id;
  }

  const out = (await call('POST', '/v1/profiles', {
    handle: HANDLE,
    title: 'Giorgi',
    bio: 'Building things on the internet. Mostly at night.',
    avatarUrl: 'https://avatars.githubusercontent.com/u/9919?s=200&v=4',
  })) as { data: { id: string } };
  console.log(`  created /${HANDLE}`);
  return out.data.id;
}

/**
 * The four blocks, and the three rules that make the page worth looking at.
 *
 * Each rule demonstrates one dimension the evaluator keys on, because the
 * point of the seed is the simulator: with nothing to switch on, the control
 * panel is a set of dropdowns that never change the frame.
 */
async function build(id: string): Promise<void> {
  const block = async (input: Json): Promise<string> => {
    const out = (await call('POST', `/v1/profiles/${id}/blocks`, input, { match: true })) as {
      data: { id: string };
    };
    return out.data.id;
  };

  const rules = (blockId: string, set: Json[]) =>
    call('PUT', `/v1/profiles/${id}/blocks/${blockId}/rules`, set, { match: true });

  const existing = (await call('GET', `/v1/profiles/${id}`)) as { blocks?: unknown[] };
  if (existing.blocks?.length) {
    console.log(`  ${existing.blocks.length} blocks already there — leaving them alone`);
    return;
  }

  await block({ kind: 'header', label: 'Out now' });

  // Geo: the same button, a different shop, decided at the edge.
  const merch = await block({
    kind: 'link',
    label: 'Merch',
    icon: '🧢',
    target: 'https://shop.example.com/intl',
  });
  await rules(merch, [
    {
      id: 'merch-eu',
      priority: 10,
      when: [{ dim: 'geo', in: ['eu'] }],
      then: { kind: 'redirect', target: 'https://shop.example.com/eu', status: 302 },
    },
    {
      id: 'merch-na',
      priority: 20,
      when: [{ dim: 'geo', in: ['na'] }],
      then: { kind: 'redirect', target: 'https://shop.example.com/us', status: 302 },
    },
  ]);

  // Device: the app store link only makes sense on a phone.
  const app = await block({
    kind: 'link',
    label: 'Get the app',
    icon: '📱',
    target: 'https://example.com/app',
  });
  await rules(app, [
    { id: 'app-desktop', priority: 10, when: [{ dim: 'device', in: ['desktop'] }], then: { kind: 'hide' } },
  ]);

  // Time: a window that closes, in a named zone, so DST is a real question.
  const show = await block({
    kind: 'link',
    label: 'Tonight’s set',
    icon: '🎧',
    target: 'https://example.com/live',
  });
  await rules(show, [
    {
      id: 'set-offhours',
      priority: 10,
      when: [{ dim: 'time', tz: 'Asia/Tbilisi', from: '02:00', to: '20:00' }],
      then: { kind: 'hide' },
    },
  ]);

  // A feed, so the refresher has something to walk. RSS needs no credential.
  await block({
    kind: 'feed',
    label: 'Writing',
    feed: { source: 'rss', ref: 'https://hnrss.org/frontpage', ttlSeconds: 900 },
  });

  console.log('  4 blocks, 4 rules');
}

console.log(`Seeding ${API}`);
await authenticate();
const id = await profile();
await build(id);
await call('POST', `/v1/profiles/${id}/publish`, {}, { match: true });

console.log(`
Published. 

  page       ${process.env.SITE ?? 'http://localhost:3000'}/${HANDLE}
  dashboard  ${process.env.SITE ?? 'http://localhost:3000'}/app
  sign in    ${EMAIL} / ${PASSWORD}

The feed block fills on the next refresher pass — immediately with
DB_DRIVER=memory, where the dev server runs it in-process, or from the block's
own "Fetch now" button.`);
