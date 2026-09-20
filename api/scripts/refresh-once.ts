/**
 * One refresh pass, from a terminal.
 *
 * The scheduled Lambda is the only thing that runs this in production, which
 * makes a feed that will not load hard to debug — the failure is a `feedError`
 * on a row in DynamoDB fifteen minutes later. This runs the same code path
 * against whichever driver is configured and prints what happened.
 *
 *   DB_DRIVER=dynamo TABLE_NAME=linkbio npm run refresh:once
 */
import { refreshDue } from '../src/feeds/refresh.ts';
import { DynamoRepo } from '../src/db/dynamo.ts';
import { MemoryRepo } from '../src/db/memory.ts';
import { env } from '../src/env.ts';

const repo = env.driver === 'memory' ? new MemoryRepo() : new DynamoRepo();

const summary = await refreshDue(repo);

for (const o of summary.outcomes) {
  if (o.status === 'ok') console.log(`  ok           ${o.blockId}  ${o.items} items`);
  else if (o.status === 'unconfigured') console.log(`  unconfigured ${o.blockId}  ${o.error}`);
  else console.log(`  failed (${o.failures}x) ${o.blockId}  ${o.error}`);
}

console.log(
  `\n${summary.scanned} due · ${summary.ok} ok · ${summary.failed} failed · ${summary.unconfigured} unconfigured`,
);

if (summary.scanned === 0) {
  console.log('Nothing was due. Feed blocks come due one TTL after their last attempt.');
}
