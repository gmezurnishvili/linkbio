import type { Context } from 'hono';

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (m: string, d?: unknown) => new ApiError(400, 'bad_request', m, d);
export const unauthorized = (m = 'missing or invalid credentials') => new ApiError(401, 'unauthorized', m);
export const forbidden = (m = 'not your resource') => new ApiError(403, 'forbidden', m);
export const notFound = (m = 'not found') => new ApiError(404, 'not_found', m);
export const conflict = (m: string) => new ApiError(409, 'conflict', m);
export const tooMany = (m = 'rate limited') => new ApiError(429, 'rate_limited', m);

/** RFC 9457 problem+json. */
export function onError(err: Error, c: Context) {
  const e = err instanceof ApiError ? err : new ApiError(500, 'internal', 'internal error');
  if (!(err instanceof ApiError)) console.error('unhandled', err);
  c.status(e.status as 400);
  c.header('content-type', 'application/problem+json');
  return c.body(JSON.stringify({
    type: `https://errors.example/${e.code}`,
    title: e.code,
    status: e.status,
    detail: e.message,
    errors: e.detail,
  }));
}
