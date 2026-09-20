/**
 * Builds the web app and assembles `dist/` — the directory `api/infra/stack.ts`
 * uploads as the web Lambda's code.
 *
 * It runs `next build` itself rather than leaving that to the caller, because
 * the build is where `NEXT_PUBLIC_*` values are decided. Next inlines those as
 * literals at build time, in server code as well as client code, so a Lambda
 * environment variable can never change one afterwards — and `.env.local`,
 * which every developer has and which points at `localhost:8787`, is loaded by
 * `next build` unless something has already set the variable. Left alone, a
 * deploy built on a developer's machine ships a click beacon aimed at their own
 * laptop. Setting them here is what makes the artifact independent of whose
 * machine produced it.
 *
 * `output: "standalone"` emits a server and its traced dependencies but omits
 * the two things it cannot know the deployment wants: `.next/static` and
 * `public/`. Here they are served by the same Lambda and cached at the edge, so
 * both are copied in.
 *
 * Node rather than a shell script because this repo is built on Windows, where
 * `cp -r` is not a command and a `.sh` file is not executable.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, 'dist');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything is one origin behind one distribution, so the browser-facing paths
 * are relative and need no hostname baked in.
 *
 * `SITE_ORIGIN` is the exception: it becomes the canonical URL and the JSON-LD
 * `@id`, and it can only be known once there is a domain. Left empty, the page
 * falls back at request time to the host the edge function forwards, which is
 * correct but means the canonical URL is the `*.cloudfront.net` name until a
 * domain exists.
 */
const PUBLIC_ENV = {
  NEXT_PUBLIC_API_BASE: '/api/proxy',
  NEXT_PUBLIC_BEACON_URL: '/v1/events',
  // Only when there is one. Passing an empty string looks like a no-op and is
  // not: Windows cannot hold an empty environment variable, so `FOO=''` arrives
  // at the child as *absent*, Next then falls back to `.env.local`, and the
  // build quietly ships a developer's `http://localhost:3000` as the canonical
  // origin. The env files are hidden below for the same reason, but a value
  // that means two different things on two operating systems should not be
  // passed at all.
  ...(process.env.SITE_ORIGIN ? { NEXT_PUBLIC_SITE_ORIGIN: process.env.SITE_ORIGIN } : {}),
};

/**
 * `.env.local` and `.env` belong to whoever is building, and they point at
 * localhost. `next build` loads them, and a deployable artifact must not depend
 * on whose machine produced it, so they are moved out of the way for the
 * duration and put back afterwards.
 *
 * Restored in a `finally` and on a signal; a leftover `.hidden-by-build` file
 * from a hard kill is restored on the next run before anything else happens.
 */
const HIDDEN = '.hidden-by-build';
const ENV_FILES = ['.env.local', '.env', '.env.development', '.env.development.local'];

async function restoreEnvFiles() {
  for (const name of ENV_FILES) {
    const hidden = join(web, name + HIDDEN);
    if (await exists(hidden)) await rename(hidden, join(web, name));
  }
}

async function hideEnvFiles() {
  await restoreEnvFiles(); // anything left by a previous hard kill
  const hidden = [];
  for (const name of ENV_FILES) {
    const from = join(web, name);
    if (await exists(from)) {
      await rename(from, from + HIDDEN);
      hidden.push(name);
    }
  }
  return hidden;
}

// A previous build whose tracing root resolved elsewhere leaves its own tree
// behind, and Next does not clear it. Removing it first means the check below
// is looking at this build's output and not at last build's.
await rm(join(web, '.next', 'standalone'), { recursive: true, force: true });

/**
 * The local Next binary, run directly.
 *
 * Not `npx`: this script is also invoked from `api/`, and npx resolves against
 * the *caller's* node_modules first — where `next` is not installed — at which
 * point it offers to fetch it from the registry. Not a package manager either,
 * so there is no `--prefix` behaviour to differ between platforms.
 */
const nextBin = join(web, 'node_modules', 'next', 'dist', 'bin', 'next');
if (!(await exists(nextBin))) {
  console.error(`\nNext is not installed in ${join(web, 'node_modules')}.\n  → cd web && npm ci`);
  process.exit(1);
}

const hidden = await hideEnvFiles();
if (hidden.length) console.log(`Building with ${hidden.join(', ')} set aside.`);
process.once('SIGINT', () => { void restoreEnvFiles().then(() => process.exit(130)); });

let build;
try {
  build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: web,
    stdio: 'inherit',
    env: { ...process.env, ...PUBLIC_ENV, NODE_ENV: 'production' },
  });
} finally {
  await restoreEnvFiles();
}
if (build.status !== 0) process.exit(build.status ?? 1);

const standalone = join(web, '.next', 'standalone');
if (!(await exists(join(standalone, 'server.js')))) {
  // Two causes, and they need different fixes, so say which one this is. The
  // symptom without this check is a Lambda that deploys and 502s on every
  // request.
  const nested = await findServer(standalone, 6);
  if (nested) {
    console.error(
      `\nserver.js is at ${nested}, not at the root of .next/standalone.\n` +
      'Next resolved its file-tracing root above this directory — usually a\n' +
      'stray package.json or lockfile in a parent folder, as far up as your home\n' +
      'directory. `outputFileTracingRoot` in next.config.ts is what pins it; if\n' +
      'that is set and this still happens, it is not pointing at web/.',
    );
  } else {
    console.error(
      '\nNo server.js anywhere under .next/standalone after the build.\n' +
      'Set `output: "standalone"` in next.config.ts.',
    );
  }
  process.exit(1);
}

/** The build's own server.js, if the tracing root put it somewhere unexpected. */
async function findServer(root, depth) {
  if (depth === 0 || !(await exists(root))) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isFile() && entry.name === 'server.js') return join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findServer(join(root, entry.name), depth - 1);
      if (found) return found;
    }
  }
  return null;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(standalone, dist, { recursive: true });
await cp(join(web, '.next', 'static'), join(dist, '.next', 'static'), { recursive: true });
if (await exists(join(web, 'public'))) {
  await cp(join(web, 'public'), join(dist, 'public'), { recursive: true });
}
await cp(join(web, 'lambda', 'handler.mjs'), join(dist, 'handler.mjs'));

/**
 * What dependency tracing pulls in that this Lambda must not ship.
 *
 * `.env` and friends: Next copies them into the standalone output, and they are
 * the developer's — `API_ORIGIN=http://localhost:8787`. Lambda's environment
 * wins today, because Next's loader does not overwrite a variable that is
 * already set, so this is not currently a live bug. It is the kind that becomes
 * one silently: drop `API_ORIGIN` from the stack and the Lambda would quietly
 * start calling localhost instead of failing with the error that names it.
 *
 * `sharp`/`@img`: native binaries for the build machine's platform, traced in
 * by the image optimizer. `images.unoptimized` turns the optimizer off, so they
 * are unreachable — but tracing is conservative and still copies them, 37 MB of
 * them, for an architecture that is only right by luck.
 *
 * `typescript`: traced because next.config.ts is TypeScript. The server reads
 * the compiled config out of `.next/required-server-files.json` and never the
 * source, so the compiler is 9 MB of cold start for nothing.
 *
 * Everything removed here is covered by test/lambda-handler.test.mjs, which
 * boots this exact directory — a prune that broke the server would fail there
 * rather than on the first request after a deploy.
 */
const PRUNE = [
  '.env', '.env.local', '.env.development', '.env.production',
  'node_modules/sharp',
  'node_modules/@img',
  'node_modules/typescript',
];
for (const relative of PRUNE) {
  await rm(join(dist, relative), { recursive: true, force: true });
}

/**
 * When this bundle was built, and from what.
 *
 * Written rather than inferred from a file's mtime, because most of `dist` is
 * *copied* — and `fs.cp` on Windows goes through `CopyFileW`, which preserves
 * the source's timestamp. `dist/handler.mjs` therefore carries the mtime of
 * `lambda/handler.mjs`, which can be weeks old, while the build that produced
 * it happened seconds ago. `api/infra/freshness.ts` reads this file instead;
 * relying on the copy's mtime made it refuse every deploy, fresh or not.
 *
 * The rest is for whoever is staring at a deployed bundle wondering what went
 * into it.
 */
await writeFile(
  join(dist, '.build-stamp'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      builtAtMs: Date.now(),
      siteOrigin: PUBLIC_ENV.NEXT_PUBLIC_SITE_ORIGIN ?? null,
      node: process.version,
      platform: process.platform,
    },
    null,
    2,
  ) + '\n',
);

console.log(`\nPackaged web/dist — handler.mjs + the standalone server.`);
console.log(`  NEXT_PUBLIC_SITE_ORIGIN: ${PUBLIC_ENV.NEXT_PUBLIC_SITE_ORIGIN ?? '(unset — the app falls back to the forwarded viewer host)'}`);
