import { handle } from 'hono/aws-lambda';
import { createApp } from './app.ts';
import { DynamoRepo } from './db/dynamo.ts';
import { MemoryRepo } from './db/memory.ts';
import { env } from './env.ts';

const repo = env.driver === 'memory' ? new MemoryRepo() : new DynamoRepo();
export const handler = handle(createApp(repo));
