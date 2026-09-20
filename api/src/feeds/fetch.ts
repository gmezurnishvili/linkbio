import { isPublicHttpUrl } from '../domain/schema.ts';

/**
 * The one way feed adapters reach the network.
 *
 * `SafeUrl` validates what a creator types, which is necessary and not
 * sufficient: `http://evil.test/` passes validation and then 302s to
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`. Letting
 * `fetch` follow redirects means the check only ever ran against the first hop.
 * So redirects are followed by hand, every hop is re-validated, and the body is
 * read through a cap rather than trusted to be a feed-sized document.
 */

export type Fetcher = typeof fetch;

export type FetchOptions = {
  fetch?: Fetcher;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Fail the request unless the final URL is on one of these hosts. */
  allowHosts?: string[];
};

export class FeedFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FeedFetchError';
    this.status = status;
  }
}

const UA = 'linkbio-feed/1.0 (+https://github.com/gmezurnishvili/linkbio)';

export const DEFAULTS = {
  timeoutMs: 8_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
};

export async function fetchPublic(url: string, opts: FetchOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isPublicHttpUrl(current)) {
      throw new FeedFetchError(`refusing to fetch a private or non-http target: ${redact(current)}`);
    }
    if (opts.allowHosts && !opts.allowHosts.includes(new URL(current).hostname.toLowerCase())) {
      throw new FeedFetchError(`unexpected host ${new URL(current).hostname}`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULTS.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(current, {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': UA, accept: '*/*', ...opts.headers },
        body: opts.body,
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (e) {
      throw new FeedFetchError(
        ac.signal.aborted ? `timed out after ${opts.timeoutMs ?? DEFAULTS.timeoutMs}ms` : String(e),
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new FeedFetchError(`redirect with no location`, res.status);
      // Relative locations are legal and common; resolve against the hop we are
      // on, then loop so the new target is validated like any other.
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok) throw new FeedFetchError(`upstream returned ${res.status}`, res.status);
    return await readCapped(res, maxBytes);
  }

  throw new FeedFetchError(`more than ${maxRedirects} redirects`);
}

/** JSON convenience. Adapters that talk to an API rather than a feed use this. */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchPublic(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FeedFetchError('upstream returned something that is not JSON');
  }
}

/**
 * Reads at most `maxBytes`, without materialising more than that.
 *
 * `res.text()` then `.slice()` would already have the whole body in memory,
 * which is the thing the cap exists to prevent — a 2 GB "feed" would OOM the
 * function before the slice ran.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new FeedFetchError(`body is ${declared} bytes, over the ${maxBytes} cap`);

  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // A test double, or a runtime without streams. Fall back, but still refuse
    // to hand back more than the cap.
    const text = await res.text();
    if (text.length > maxBytes) throw new FeedFetchError(`body exceeds the ${maxBytes} byte cap`);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FeedFetchError(`body exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return new TextDecoder('utf-8').decode(joined);
}

/** Query strings on a rejected URL can carry a token; the host is the useful part. */
function redact(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}
