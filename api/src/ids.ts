import { randomBytes } from 'node:crypto';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Lexicographically sortable, time-prefixed id. */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = [...randomBytes(10)].map((b) => B32[b % 32]).join('');
  return `${prefix}_${time}${rand}`;
}
