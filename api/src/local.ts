import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { MemoryRepo } from './db/memory.ts';
import { DynamoRepo } from './db/dynamo.ts';
import { refreshDue } from './feeds/refresh.ts';
import { env } from './env.ts';

const repo = env.driver === 'memory' ? new MemoryRepo() : new DynamoRepo();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(repo).fetch, port });
console.log(`listening on http://localhost:${port} (driver=${env.driver})`);

/**
 * The refresher, in-process, for the memory driver only.
 *
 * In production the refresher is a separate Lambda on an EventBridge schedule,
 * reading the same rows out of DynamoDB. With `DB_DRIVER=memory` there is no
 * shared table: `npm run refresh:once` constructs its own `MemoryRepo` in its
 * own process and scans an empty heap, so a feed block added through the API
 * here could never be filled by anything, ever. The block was not broken — the
 * only consumer of the index was in a different heap.
 *
 * So the loop runs here, against the same repo the API is serving from. This is
 * a development affordance and deliberately conditional: with `dynamo` the real
 * scheduled function owns this work, and a second refresher racing it would
 * double every third-party fetch.
 */
if (env.driver === 'memory') {
  const everyMs = Number(process.env.FEED_REFRESH_INTERVAL_MS ?? 60_000);
  if (everyMs > 0) {
    let running = false;
    const tick = async () => {
      // A slow third party must not let two passes overlap; the due-time index
      // is idempotent but the fetches are not free.
      if (running) return;
      running = true;
      try {
        const summary = await refreshDue(repo);
        if (summary.scanned > 0) {
          console.log(JSON.stringify({
            level: 'info',
            msg: 'feed refresh (dev)',
            scanned: summary.scanned,
            ok: summary.ok,
            failed: summary.failed,
            unconfigured: summary.unconfigured,
          }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', msg: 'feed refresh (dev) failed', err: String(err) }));
      } finally {
        running = false;
      }
    };

    // Not `unref`ed: this is a foreground dev server and the loop should keep
    // the same lifetime as the listener.
    setInterval(() => void tick(), everyMs);
    // A feed block added a second ago is due a second ago, so waiting a full
    // interval before the first pass is the difference between "it filled" and
    // "it is still empty" on a first run.
    void tick();
    console.log(`feed refresher running in-process every ${Math.round(everyMs / 1000)}s`);
  }
}
