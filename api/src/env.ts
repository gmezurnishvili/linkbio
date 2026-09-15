import { z } from 'zod';

/**
 * Configuration is parsed once, at module load, and a bad value stops the
 * process. The previous version was a list of `process.env.X ?? default`
 * expressions, which meant `MAX_BLOCKS=twohundred` silently became `NaN` and
 * `existing.length >= NaN` silently became "no limit". A misconfigured limit
 * that disappears is worse than one that refuses to boot.
 */

const IntFrom = (fallback: number, min = 1, max = 100_000) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const Schema = z
  .object({
    TABLE_NAME: z.string().min(1).default('linkbio'),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    KVS_ARN: z.string().default(''),
    JWKS_URL: z.string().url().or(z.literal('')).default(''),
    JWT_ISSUER: z.string().default(''),
    JWT_AUDIENCE: z.string().default(''),
    // Signs the tokens this API issues itself, and verifies them on the way
    // back in. Required unless an external issuer (JWKS_URL) owns identity.
    AUTH_SECRET: z.string().default(''),
    DEV_JWT_SECRET: z.string().default(''),
    DB_DRIVER: z.enum(['dynamo', 'memory']).default('dynamo'),
    NODE_ENV: z.string().default('development'),
    // Comma-separated exact origins. `*` is accepted but only outside
    // production, so a development convenience cannot ship by accident.
    CORS_ORIGINS: z.string().default(''),
    MAX_BLOCKS: IntFrom(200),
    MAX_RULES: IntFrom(20, 1, 200),
    MAX_BODY_BYTES: IntFrom(256 * 1024, 1024, 8 * 1024 * 1024),
    ACCESS_TTL_SECONDS: IntFrom(900, 60, 86_400),
    REFRESH_TTL_SECONDS: IntFrom(30 * 86_400, 3600, 365 * 86_400),
    EVENTS_PER_MINUTE: IntFrom(120, 1, 100_000),
  })
  .superRefine((v, ctx) => {
    const prod = v.NODE_ENV === 'production';

    if (prod && v.DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEV_JWT_SECRET'],
        message:
          'DEV_JWT_SECRET must not be set in production — it turns the whole API into a shared symmetric secret. Use AUTH_SECRET or JWKS_URL.',
      });
    }

    // An external issuer without an audience accepts every token that issuer
    // has ever minted, including ones for other apps in the same pool.
    if (prod && v.JWKS_URL && !v.JWT_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_AUDIENCE'],
        message: 'JWT_AUDIENCE is required when JWKS_URL is set, or tokens minted for other apps on the same issuer are accepted.',
      });
    }

    const secret = v.AUTH_SECRET || v.DEV_JWT_SECRET;
    if (!v.JWKS_URL && !secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message: 'Set AUTH_SECRET (or JWKS_URL, or DEV_JWT_SECRET outside production). Without one, every authenticated request fails with 401.',
      });
    }
    if (secret && secret.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message: 'The signing secret must be at least 32 bytes.',
      });
    }

    if (prod && v.CORS_ORIGINS.trim() === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS=* is not allowed in production. List exact origins.',
      });
    }
  });

function load() {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid configuration\n${lines.join('\n')}`);
  }
  const v = parsed.data;

  return {
    tableName: v.TABLE_NAME,
    region: v.AWS_REGION,
    kvsArn: v.KVS_ARN,
    jwksUrl: v.JWKS_URL,
    jwtIssuer: v.JWT_ISSUER,
    jwtAudience: v.JWT_AUDIENCE,
    /** Signs and verifies tokens this API issues. Empty when JWKS owns identity. */
    authSecret: v.AUTH_SECRET || (v.NODE_ENV === 'production' ? '' : v.DEV_JWT_SECRET),
    driver: v.DB_DRIVER,
    isProduction: v.NODE_ENV === 'production',
    corsOrigins: v.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    maxBlocks: v.MAX_BLOCKS,
    maxRules: v.MAX_RULES,
    maxBodyBytes: v.MAX_BODY_BYTES,
    accessTtlSeconds: v.ACCESS_TTL_SECONDS,
    refreshTtlSeconds: v.REFRESH_TTL_SECONDS,
    eventsPerMinute: v.EVENTS_PER_MINUTE,
  };
}

export const env = load();
export type Env = typeof env;
