import { SignJWT } from 'jose';
const secret = process.env.DEV_JWT_SECRET ?? 'a-secret-at-least-32-bytes-long!!';
const sub = process.argv[2] ?? 'u1';
console.log(await new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setExpirationTime('12h')
  .sign(new TextEncoder().encode(secret)));
