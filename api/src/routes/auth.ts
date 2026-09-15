import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { SignJWT } from 'jose';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Credentials, RefreshInput } from '../domain/schema.ts';
import { fromRepo, tooMany, unauthorized } from '../errors.ts';
import { SELF_AUDIENCE, SELF_ISSUER } from '../auth.ts';
import { env } from '../env.ts';
import type { Repo } from '../db/repo.ts';
import type { Env } from '../app.ts';

export const auth = new Hono<Env>();

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

// Deliberately slow. These are the defaults scrypt's own guidance recommends
// for interactive logins; they cost ~100ms, which is the point.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Refresh tokens are stored hashed, so a leaked table dump is not a set of live sessions. */
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

async function issue(repo: Repo, userId: string) {
  if (!env.authSecret) throw unauthorized('auth is not configured');
  const secret = new TextEncoder().encode(env.authSecret);
  const now = Math.floor(Date.now() / 1000);

  const accessToken = await new SignJWT({ typ: 'access', scope: 'profiles:write' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(SELF_ISSUER)
    .setAudience(SELF_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + env.accessTtlSeconds)
    .sign(secret);

  // Opaque, not a JWT: it is checked against the database on every use, so it
  // has to be revocable, and a self-describing token is not. The user id is
  // prefixed in the clear so the lookup is a point read — the secret half is
  // the random suffix, and only its hash is stored.
  const refreshToken = `${userId}.${randomBytes(32).toString('base64url')}`;
  await repo.putRefreshToken({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt: Date.now() + env.refreshTtlSeconds * 1000,
    createdAt: Date.now(),
  });

  return { accessToken, refreshToken, expiresIn: env.accessTtlSeconds };
}

/**
 * A crude per-process throttle on the credential endpoints.
 *
 * On Lambda each container keeps its own counter, so this is a speed bump
 * rather than a control — the real one belongs in WAF, which the stack now
 * configures. It is here because unauthenticated scrypt work is a denial of
 * service against ourselves.
 */
const attempts = new Map<string, { n: number; resetAt: number }>();
function throttle(key: string, limit: number) {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || cur.resetAt <= now) {
    attempts.set(key, { n: 1, resetAt: now + 60_000 });
    if (attempts.size > 10_000) attempts.clear();
    return;
  }
  cur.n += 1;
  if (cur.n > limit) throw tooMany('too many attempts, try again in a minute');
}

const clientKey = (c: { req: { header(n: string): string | undefined } }) =>
  c.req.header('cloudfront-viewer-address') ?? c.req.header('x-forwarded-for') ?? 'unknown';

auth.post('/register', zValidator('json', Credentials), async (c) => {
  throttle(`reg:${clientKey(c)}`, 10);
  const { email, password } = c.req.valid('json');
  try {
    const user = await c.var.repo.createUser(email, await hashPassword(password));
    return c.json(await issue(c.var.repo, user.id), 201);
  } catch (e) {
    const mapped = fromRepo(e);
    if (mapped) throw mapped;
    throw e;
  }
});

auth.post('/token', zValidator('json', Credentials), async (c) => {
  throttle(`tok:${clientKey(c)}`, 20);
  const { email, password } = c.req.valid('json');
  const user = await c.var.repo.getUserByEmail(email);

  // Verify against a dummy hash when the account does not exist, so the
  // response time does not say whether an email is registered.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, DUMMY_HASH), false);
  if (!user || !ok) throw unauthorized('email or password is wrong');

  return c.json(await issue(c.var.repo, user.id));
});

auth.post('/refresh', zValidator('json', RefreshInput), async (c) => {
  throttle(`ref:${clientKey(c)}`, 60);
  const { refreshToken } = c.req.valid('json');
  const userId = refreshToken.split('.')[0] ?? '';
  if (!userId) throw unauthorized('refresh token is not valid');

  const rec = await c.var.repo.consumeRefreshToken(userId, hashToken(refreshToken));
  if (!rec) {
    // Either expired or already used. Rotation makes reuse meaningful: a second
    // use of the same token is the signal that one leaked, so every session for
    // that user goes with it.
    await c.var.repo.revokeRefreshTokens(userId);
    throw unauthorized('refresh token is not valid');
  }
  return c.json(await issue(c.var.repo, rec.userId));
});

// Generated once at module load; its only job is to cost the same as a real one.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export const _internal = { hashPassword, verifyPassword, hashToken };
