import { zValidator as base } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodSchema } from 'zod';
import { badRequest } from '../errors.ts';

/**
 * Hono's zod validator, with failures reshaped into problem+json so clients
 * get a list of offending field paths instead of a bare 400.
 */
export function zValidator<T extends ZodSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return base(target, schema, (result) => {
    if (!result.success) {
      throw badRequest('validation failed', result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })));
    }
  });
}
