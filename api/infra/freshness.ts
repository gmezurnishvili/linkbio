import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Refuses to synthesize against a stale Lambda bundle.
 *
 * Both Lambdas are uploaded as directory assets, which CDK resolves at synth
 * time from whatever happens to be on disk. Nothing about `cdk deploy` knows or
 * cares that `web/dist` was built before the source it is supposed to contain,
 * so a retry after a failed deploy — the most natural thing in the world to do —
 * silently ships the previous build.
 *
 * That is not a theoretical hazard. It happened: a deploy retried without
 * rebuilding shipped a web bundle from before the same-origin fix, and every
 * write in the dashboard came back "Cross-origin request refused" from code
 * that had already been corrected. The deploy succeeded, the stack was right,
 * and the artifact was a hour old.
 *
 * Comparing timestamps is crude and that is the point — it needs no build
 * system and it cannot itself be out of date.
 *
 * The one subtlety is *which* timestamp. Most of `web/dist` is copied there,
 * and `fs.cp` on Windows preserves the source's mtime, so a copied file can
 * carry a timestamp far older than the build that placed it. Reading the mtime
 * of one of those made this refuse every deploy on Windows, fresh or not. A
 * bundle therefore states its own build time in `.build-stamp`, and the mtime
 * is only a fallback for a bundle built before that existed.
 */

/** Newest mtime under `root`, skipping build output, dependencies and tests. */
function newestSource(root: string): { path: string; mtimeMs: number } | null {
  if (!existsSync(root)) return null;

  const skip = new Set(['node_modules', 'dist', 'dist-refresher', '.next', 'cdk.out', '.git']);
  let newest: { path: string; mtimeMs: number } | null = null;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      // A changed test does not invalidate a bundle, and forcing a rebuild for
      // one would teach people to pass --context skipStaleCheck.
      if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const { mtimeMs } = statSync(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    }
  };
  walk(root);
  return newest;
}

export interface Bundle {
  /** Human name, for the error. */
  name: string;
  /** A file the build produces. Its mtime is used only when there is no stamp. */
  artifact: string;
  /** A JSON file carrying `builtAtMs`, written by the build. Preferred. */
  stamp?: string;
  /** Directories whose contents the bundle is built from. */
  sources: string[];
  /** What to run to rebuild it. */
  rebuild: string;
}

/** When this bundle says it was built, or failing that when its artifact was written. */
function builtAt(bundle: Bundle): number {
  if (bundle.stamp && existsSync(bundle.stamp)) {
    try {
      const stamp = JSON.parse(readFileSync(bundle.stamp, 'utf8')) as { builtAtMs?: number };
      if (typeof stamp.builtAtMs === 'number') return stamp.builtAtMs;
    } catch {
      // A corrupt stamp is not worth failing a deploy over; the mtime below is
      // conservative in the right direction.
    }
  }
  return statSync(bundle.artifact).mtimeMs;
}

export function assertFresh(bundles: Bundle[]): void {
  const stale: string[] = [];

  for (const bundle of bundles) {
    if (!existsSync(bundle.artifact)) {
      stale.push(`  ${bundle.name}: not built at all (${bundle.artifact} is missing)\n      → ${bundle.rebuild}`);
      continue;
    }
    const built = builtAt(bundle);
    const newest = bundle.sources
      .map(newestSource)
      .filter((x): x is { path: string; mtimeMs: number } => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

    if (newest && newest.mtimeMs > built) {
      const minutes = Math.round((newest.mtimeMs - built) / 60_000);
      stale.push(
        `  ${bundle.name}: built ${minutes} minute${minutes === 1 ? '' : 's'} before ` +
        `${newest.path} was last changed\n      → ${bundle.rebuild}`,
      );
    }
  }

  if (stale.length === 0) return;

  throw new Error(
    'Refusing to synthesize against a stale bundle.\n\n' +
    stale.join('\n') +
    '\n\nBoth Lambdas are uploaded as directory assets, resolved from disk at synth\n' +
    'time — deploying now would ship the previous build and the symptoms would\n' +
    'look like infrastructure faults. Pass -c skipStaleCheck=true to override.\n',
  );
}
