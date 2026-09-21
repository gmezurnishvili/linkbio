#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { LinkbioStack } from './stack.ts';
import { assertFresh } from './freshness.ts';
import { assertDomainIntent, bundleHostFrom } from './domain-check.ts';

/**
 * The entrypoint `cdk.json` runs.
 *
 * There was no app and no `cdk.json`, so the `npx cdk deploy` the README
 * prescribes had nothing to synthesize — and `aws-cdk-lib` was not a dependency
 * either, which meant `infra/stack.ts` had never been typechecked. It is now in
 * the `tsconfig` include list.
 */
const app = new App();

// Before anything is synthesized, because a stale asset produces a successful
// deploy of the wrong code — the worst failure mode available here.
if (!app.node.tryGetContext('skipStaleCheck')) {
  assertFresh([
    {
      name: 'web',
      artifact: '../web/dist/handler.mjs',
      stamp: '../web/dist/.build-stamp',
      sources: ['../web/src', '../web/lambda'],
      rebuild: 'cd ../web && npm run build:lambda',
    },
    {
      name: 'api',
      artifact: 'dist/index.mjs',
      sources: ['src'],
      rebuild: 'cd api && npm run build',
    },
  ]);
}

const corsOrigins = (app.node.tryGetContext('corsOrigins') as string | undefined)?.split(',').filter(Boolean);

/**
 * The shared secret CloudFront presents to both origins.
 *
 * An environment variable first, and a context value only as an alternative,
 * because a secret passed on the command line ends up in shell history and in
 * the process list. `LINKBIO_` rather than the `ORIGIN_SECRET` the Lambdas read
 * at runtime: exporting that name in a development shell would make the local
 * API demand a header nothing local sends.
 *
 * Omitted, the function URLs answer anyone who finds them — see the prop's
 * comment in stack.ts.
 */
const originSecret: string | undefined =
  process.env.LINKBIO_ORIGIN_SECRET || app.node.tryGetContext('originSecret') || undefined;

if (!originSecret) {
  console.warn(
    '\n  warning: no origin secret. Both Lambda function URLs will answer anyone\n' +
    '  who finds them, bypassing the WAF. Set LINKBIO_ORIGIN_SECRET to close that.\n',
  );
}

/**
 * The custom domain.
 *
 * First cutover, two deploys, because the wait in the middle belongs to a
 * registrar:
 *
 *   npx cdk deploy -c domain=chamelink.app -c createHostedZone=1
 *   # paste the four Nameservers at the registrar, wait for the delegation
 *   npx cdk deploy -c domain=chamelink.app -c createHostedZone=1 -c attachDomain=1
 *
 * Afterwards, with the zone delegated and outliving the stack:
 *
 *   LINKBIO_DOMAIN=chamelink.app LINKBIO_ATTACH_DOMAIN=1 \
 *   LINKBIO_HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ npm run deploy
 *
 * `attachDomain` waits on the registrar: until the delegation points at the
 * zone's nameservers, ACM cannot validate a certificate and the deploy hangs
 * rather than failing. `stack.ts` has the long version.
 *
 * The zone is reused rather than created once a cutover has happened, because
 * the zone carries `RemovalPolicy.RETAIN` and therefore survives being dropped
 * from the stack. Creating a second one for the same name is silent and
 * useless: the registrar still delegates to the first.
 */
const domainName: string | undefined =
  app.node.tryGetContext('domain') || process.env.LINKBIO_DOMAIN || undefined;

const flag = (context: string, env: string | undefined) =>
  ['1', 'true', 'yes'].includes(String(app.node.tryGetContext(context) ?? env ?? '').trim().toLowerCase());

const attachDomain = flag('attachDomain', process.env.LINKBIO_ATTACH_DOMAIN);
const createHostedZone = flag('createHostedZone', process.env.LINKBIO_CREATE_HOSTED_ZONE);

/** An existing, already-delegated zone to hold the records. Route 53 prints it with a `/hostedzone/` prefix. */
const hostedZoneId: string | undefined = (
  app.node.tryGetContext('hostedZoneId') || process.env.LINKBIO_HOSTED_ZONE_ID || undefined
)?.replace(/^\/?hostedzone\//i, '');

// Every check in one place, and every one of them answerable before
// CloudFormation is asked to do anything. See domain-check.ts for the deploy
// that made this necessary.
if (!app.node.tryGetContext('skipDomainCheck')) {
  assertDomainIntent({
    domainName,
    attachDomain,
    hostedZoneId,
    createHostedZone,
    bundleHost: bundleHostFrom('../web/dist/.build-stamp'),
  });
}

new LinkbioStack(app, 'Linkbio', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  // CloudFront WebACLs and the KeyValueStore are us-east-1 only.
  crossRegionReferences: true,
  jwksUrl: app.node.tryGetContext('jwksUrl'),
  jwtIssuer: app.node.tryGetContext('jwtIssuer'),
  jwtAudience: app.node.tryGetContext('jwtAudience'),
  corsOrigins,
  originSecret,
  domainName,
  attachDomain,
  hostedZoneId,
  // Off unless asked for: a reservation needs the account to have concurrency
  // to spare, and a new account's whole limit is 10. `-c
  // refresherReservedConcurrency=1` once that has been raised.
  refresherReservedConcurrency: numberContext(
    app.node.tryGetContext('refresherReservedConcurrency') ?? process.env.LINKBIO_REFRESHER_CONCURRENCY,
  ),
});

function numberContext(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
