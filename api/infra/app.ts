#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { LinkbioStack } from './stack.ts';

/**
 * The entrypoint `cdk.json` runs.
 *
 * There was no app and no `cdk.json`, so the `npx cdk deploy` the README
 * prescribes had nothing to synthesize — and `aws-cdk-lib` was not a dependency
 * either, which meant `infra/stack.ts` had never been typechecked. It is now in
 * the `tsconfig` include list.
 */
const app = new App();

const corsOrigins = (app.node.tryGetContext('corsOrigins') as string | undefined)?.split(',').filter(Boolean);

new LinkbioStack(app, 'Linkbio', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  // CloudFront WebACLs and the KeyValueStore are us-east-1 only.
  crossRegionReferences: true,
  jwksUrl: app.node.tryGetContext('jwksUrl'),
  jwtIssuer: app.node.tryGetContext('jwtIssuer'),
  jwtAudience: app.node.tryGetContext('jwtAudience'),
  corsOrigins,
});
