/**
 * AWS Signature Version 4, for exactly one caller: the server side of this app
 * reaching the API's Lambda function URL.
 *
 * That URL is `AWS_IAM`-authenticated, because the alternative — `NONE` — is a
 * publicly reachable control plane that bypasses the WAF and the rate limit in
 * front of it. CloudFront gets in through Origin Access Control, which signs
 * with SigV4; this app has to do the same thing for its own server-to-server
 * calls, which do not go through CloudFront.
 *
 * Hand-rolled rather than `@aws-sdk/signature-v4` because the whole of what is
 * needed is below, it has no dependencies, and it is checked against AWS's
 * published vectors in sigv4.test.ts. Pulling the SDK in would add megabytes to
 * a Lambda bundle to use one function of it.
 *
 * Web Crypto rather than `node:crypto` so this module is importable from the
 * shared API client without dragging a Node built-in into the browser bundle.
 * Everything here is inert on the browser — `signingEnabled()` is false there —
 * but it still has to compile.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The execution role's credentials, which Lambda puts in the environment and
 * rotates there. Returns null anywhere that is not a Lambda (local `next dev`),
 * which is the signal to send the request unsigned — locally the API is a plain
 * HTTP server with no IAM in front of it.
 */
export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Credentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN };
}

export interface SignOptions {
  method: string;
  url: URL;
  /** Headers that will be sent. Every one of them is signed. */
  headers: Headers;
  /** The exact bytes of the body, or undefined for a bodiless request. */
  body?: string;
  service: string;
  region: string;
  credentials: Credentials;
  /** Injectable so the test vectors can pin the instant. */
  now?: Date;
  /**
   * Whether to send and sign `x-amz-content-sha256`. On by default: it makes
   * the body's part in the signature explicit, and Origin Access Control sends
   * it too. The tests turn it off to reproduce AWS's published vectors, which
   * predate the header.
   */
  contentSha256Header?: boolean;
}

/**
 * Returns the headers to send: the caller's, plus `host`, `x-amz-date`,
 * `x-amz-content-sha256`, the session token when there is one, and the
 * `Authorization` line carrying the signature.
 *
 * `Authorization` is where the signature goes, so a caller that also has a
 * bearer token to send must carry it somewhere else. `api/src/auth.ts` reads
 * `x-authorization` first for exactly this reason.
 */
export async function signRequest(opts: SignOptions): Promise<Headers> {
  const { method, url, service, region, credentials } = opts;
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(opts.body ?? "");

  const headers = new Headers(opts.headers);
  headers.set("host", url.host);
  headers.set("x-amz-date", amzDate);
  if (opts.contentSha256Header !== false) headers.set("x-amz-content-sha256", payloadHash);
  if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
  // Ours to write, and signing a stale one would guarantee a mismatch.
  headers.delete("authorization");

  const canonicalHeaders = [...headers]
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders.map(([name, value]) => `${name}:${value}`).join("\n") + "\n",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const key = await signingKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = hex(await hmac(key, stringToSign));

  lastCanonicalRequest = canonicalRequest;
  lastStringToSign = stringToSign;

  headers.set(
    "authorization",
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return headers;
}

/**
 * RFC 3986 encoding, which is not what `encodeURIComponent` does: it leaves
 * `!'()*` alone and AWS expects them percent-encoded, and a single unescaped
 * `*` is enough to make every signature on that route wrong.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Every service except S3 wants the path URI-encoded a second time. For the
 * paths this app sends — `/v1/profiles/<id>/blocks/<id>` — the second pass is a
 * no-op, but a handle or block id that ever contains a percent sign is the case
 * where getting this wrong shows up as an intermittent 403.
 */
function canonicalPath(pathname: string): string {
  if (pathname === "") return "/";
  return pathname
    .split("/")
    .map((segment) => rfc3986(safeDecode(segment)))
    .join("/");
}

/** A segment that is not valid percent-encoding is signed as the literal it is. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Sorted by name, then by value; both encoded. */
function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  params.forEach((value, name) => pairs.push([rfc3986(name), rfc3986(value)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

async function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const date = await hmac(`AWS4${secret}`, dateStamp);
  const regional = await hmac(date, region);
  const serviced = await hmac(regional, service);
  return hmac(serviced, "aws4_request");
}

/**
 * The intermediate strings from the most recent call, so the tests can compare
 * them against the ones AWS prints in its own documentation rather than against
 * a signature this repo captured from itself. Not part of the signing path.
 */
let lastCanonicalRequest = "";
let lastStringToSign = "";

export const __testing = {
  canonicalPath,
  canonicalQuery,
  hex,
  signingKey,
  lastCanonicalRequest: () => lastCanonicalRequest,
  lastStringToSign: () => lastStringToSign,
};
