import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainProblems, bundleHostFrom, type DomainIntent } from '../infra/domain-check.ts';

/**
 * The guard that would have stopped the 21 September 2026 deploy from removing
 * `chamelink.app`. Tested because the thing it protects against is invisible
 * to every other gate in the repo: `tsc` was clean, 549 tests were green, and
 * `cdk synth` produced a perfectly valid template for the wrong stack.
 */

const intent = (over: Partial<DomainIntent> = {}): DomainIntent => ({
  attachDomain: false,
  createHostedZone: false,
  ...over,
});

const matching = (problems: string[], re: RegExp) =>
  problems.filter((p) => re.test(p));

test('no domain and no baked host is the ordinary no-domain deploy', () => {
  assert.deepEqual(domainProblems(intent()), []);
});

test('the incident: a bundle built for the domain, synthesized without it', () => {
  const problems = domainProblems(intent({ bundleHost: 'chamelink.app' }));
  assert.equal(matching(problems, /attaches no custom domain/).length, 1);
  // The message has to name the variables, because the cause was that they
  // were missing from a shell and nothing said so.
  assert.match(problems.join('\n'), /LINKBIO_DOMAIN=chamelink\.app/);
});

test('a domain with neither a zone to reuse nor permission to create one', () => {
  const problems = domainProblems(
    intent({ domainName: 'chamelink.app', attachDomain: true, bundleHost: 'chamelink.app' }),
  );
  assert.equal(matching(problems, /no hostedZoneId/).length, 1);
  assert.match(problems.join('\n'), /list-hosted-zones-by-name --dns-name chamelink\.app/);
});

test('the recovery deploy is allowed', () => {
  assert.deepEqual(
    domainProblems(intent({
      domainName: 'chamelink.app',
      attachDomain: true,
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      bundleHost: 'chamelink.app',
    })),
    [],
  );
});

test('step 1 of a first cutover is allowed: create the zone, attach nothing', () => {
  assert.deepEqual(domainProblems(intent({ domainName: 'chamelink.app', createHostedZone: true })), []);
});

test('importing and creating a zone are mutually exclusive', () => {
  const problems = domainProblems(intent({
    domainName: 'chamelink.app',
    hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    createHostedZone: true,
  }));
  assert.equal(matching(problems, /contradict each other/).length, 1);
});

test('a bundle built for one custom host and a stack attaching another', () => {
  const problems = domainProblems(intent({
    domainName: 'cham.link',
    attachDomain: true,
    hostedZoneId: 'Z0123456789ABCDEFGHIJ',
    bundleHost: 'chamelink.app',
  }));
  assert.equal(matching(problems, /but the stack attaches cham\.link/).length, 1);
});

test('the real recovery configuration, with the real zone id', () => {
  assert.deepEqual(
    domainProblems(intent({
      domainName: 'chamelink.app',
      attachDomain: true,
      hostedZoneId: 'Z0942392HYD7F7J4L159',
      bundleHost: 'chamelink.app',
    })),
    [],
  );
});

test('attachDomain without a name, and a name that is not an apex', () => {
  assert.equal(matching(domainProblems(intent({ attachDomain: true })), /attachDomain needs the name/).length, 1);
  for (const bad of ['https://chamelink.app', 'www.chamelink.app', 'chamelink.app/']) {
    const problems = domainProblems(intent({ domainName: bad, createHostedZone: true }));
    assert.equal(matching(problems, /bare apex/).length, 1, bad);
  }
});

test('a zone id has to look like one, and needs a domain to belong to', () => {
  assert.equal(
    matching(domainProblems(intent({ domainName: 'chamelink.app', hostedZoneId: 'not-a-zone' })), /bare id/).length,
    1,
  );
  assert.equal(
    matching(domainProblems(intent({ hostedZoneId: 'Z0123456789ABCDEFGHIJ' })), /without domain/).length,
    1,
  );
});

test('a stack attaching a domain must ship a bundle built for it', () => {
  const base = { domainName: 'chamelink.app', attachDomain: true, hostedZoneId: 'Z0942392HYD7F7J4L159' };
  // The mirror of the incident: infrastructure moves onto the name, the
  // artifact still names CloudFront.
  assert.equal(
    matching(domainProblems(intent({ ...base, bundleHost: 'dggfai7enbv8v.cloudfront.net' })), /but the stack attaches/).length,
    1,
  );
  // And the Windows shape of it: SITE_ORIGIN unset arrives absent, so the
  // stamp records no origin at all.
  assert.equal(
    matching(domainProblems(intent(base)), /states no siteOrigin at all/).length,
    1,
  );
});

test('a bundle naming CloudFront is fine when no domain is attached', () => {
  assert.deepEqual(domainProblems(intent({ bundleHost: 'dggfai7enbv8v.cloudfront.net' })), []);
  assert.deepEqual(domainProblems(intent({ bundleHost: 'localhost' })), []);
});

test('bundleHostFrom reads the stamp verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const stamp = (siteOrigin: unknown) => {
    const path = join(dir, `${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ builtAtMs: 1, siteOrigin }));
    return path;
  };

  assert.equal(bundleHostFrom(stamp('https://chamelink.app')), 'chamelink.app');
  assert.equal(bundleHostFrom(stamp('https://CHAMELINK.app')), 'chamelink.app');
  // Returned raw: whether a host counts as a default is the rules' business.
  assert.equal(bundleHostFrom(stamp('https://dggfai7enbv8v.cloudfront.net')), 'dggfai7enbv8v.cloudfront.net');
  assert.equal(bundleHostFrom(stamp('http://localhost:3000')), 'localhost');
  assert.equal(bundleHostFrom(stamp('')), undefined);
  assert.equal(bundleHostFrom(stamp(undefined)), undefined);
  // A corrupt or absent stamp belongs to the freshness guard, not this one.
  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{not json');
  assert.equal(bundleHostFrom(corrupt), undefined);
  assert.equal(bundleHostFrom(join(dir, 'missing.json')), undefined);
});
