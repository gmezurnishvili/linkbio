import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ConflictError, NotFoundError, VersionConflictError } from './db/repo.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  /** Extra members merged into the problem document — e.g. the current version on a 409. */
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail?: unknown, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

export const badRequest = (m: string, d?: unknown) => new ApiError(400, 'bad_request', m, d);
export const unauthorized = (m = 'missing or invalid credentials') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'not your resource') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'not found') => new ApiError(404, 'not_found', m);
export const conflict = (m: string) => new ApiError(409, 'conflict', m);
export const tooMany = (m = 'rate limited') => new ApiError(429, 'rate_limited', m);
export const tooLarge = (m = 'request body too large') => new ApiError(413, 'payload_too_large', m);

/**
 * A stale If-Match. Distinct from `conflict` because the client reacts
 * differently: a version conflict means reload, a plain conflict means the
 * value is unusable. Both were 409 with no way to tell them apart, so the
 * editor raised "this page changed somewhere else" when you hit the block
 * limit.
 */
export const versionConflict = (current: number) =>
  new ApiError(409, 'version_conflict', 'the page changed since you loaded it', undefined, { current });

/**
 * Repository errors are translated here rather than at each call site. Two
 * routes previously forgot to, so `updateProfile` on a deleted profile came
 * back as a 500.
 */
export function fromRepo(err: unknown): ApiError | null {
  if (err instanceof VersionConflictError) return versionConflict(err.current);
  if (err instanceof ConflictError) return conflict(err.message);
  if (err instanceof NotFoundError) return notFound(err.message || 'not found');
  return null;
}

/** RFC 9457 problem+json. */
export function onError(err: Error, c: Context) {
  const mapped = err instanceof ApiError ? err : fromRepo(err);
  const e = mapped ?? new ApiError(500, 'internal', 'internal error');

  // The request id is in the log line and now in the response, which is the
  // only way a user-reported error can be found again.
  const requestId = c.get('requestId') as string | undefined;
  if (!mapped) console.error(JSON.stringify({ level: 'error', requestId, msg: 'unhandled', err: String(err), stack: err.stack }));

  c.status(e.status as ContentfulStatusCode);
  c.header('content-type', 'application/problem+json');
  if (requestId) c.header('x-request-id', requestId);
  return c.body(JSON.stringify({
    type: `https://errors.linkbio.dev/${e.code}`,
    title: e.code,
    status: e.status,
    detail: e.message,
    errors: e.detail,
    requestId,
    ...e.extra,
  }));
}
