import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { MemoryRepo } from './db/memory.ts';
import { DynamoRepo } from './db/dynamo.ts';
import { env } from './env.ts';

const repo = env.driver === 'memory' ? new MemoryRepo() : new DynamoRepo();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(repo).fetch, port });
console.log(`listening on http://localhost:${port} (driver=${env.driver})`);
