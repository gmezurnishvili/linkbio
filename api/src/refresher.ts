import { refreshDue } from './feeds/refresh.ts';
import { DynamoRepo } from './db/dynamo.ts';
import { MemoryRepo } from './db/memory.ts';
import { env } from './env.ts';

/**
 * The scheduled half of the feed system.
 *
 * Deployed as its own function rather than a route on the API, for two reasons.
 * It needs a 60-second timeout against the API's 10, because it is waiting on
 * five third parties; and a feed fetch that hangs should not be able to consume
 * the concurrency a creator's dashboard is trying to use.
 *
 * Idempotent by construction: the work list comes from a due-time index, and
 * the first thing every refresh does on completion is push that due time
 * forward. Two overlapping runs can duplicate a fetch but cannot corrupt
 * anything, which is the right trade for a schedule that EventBridge may fire
 * more than once.
 */

const repo = env.driver === 'memory' ? new MemoryRepo() : new DynamoRepo();

export async function handler(): Promise<{ ok: true; scanned: number; ok_count: number; failed: number }> {
  const started = Date.now();
  const summary = await refreshDue(repo);

  console.log(JSON.stringify({
    level: 'info',
    msg: 'feed refresh complete',
    scanned: summary.scanned,
    ok: summary.ok,
    failed: summary.failed,
    unconfigured: summary.unconfigured,
    ms: Date.now() - started,
  }));

  // Failures are already counted and backed off per block; throwing here would
  // retry the whole batch, re-fetching everything that succeeded. The alarm
  // watches the log metric instead.
  return { ok: true, scanned: summary.scanned, ok_count: summary.ok, failed: summary.failed };
}
