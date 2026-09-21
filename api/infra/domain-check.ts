import { existsSync, readFileSync } from 'node:fs';

/**
 * Refuses to synthesize a stack whose domain configuration contradicts itself.
 *
 * The companion to `freshness.ts`, and written for the same reason: a deploy
 * that succeeds at doing the wrong thing is worse than one that fails.
 *
 * The failure this exists to stop happened on 21 September 2026.
 * `chamelink.app` had been cut over and was serving. A later `npm run deploy`
 * ran from a fresh PowerShell window, which had `SITE_ORIGIN` and
 * `LINKBIO_ORIGIN_SECRET` — the command written down in the runbook — but not
 * `LINKBIO_DOMAIN` or `LINKBIO_ATTACH_DOMAIN`, which live only in the
 * environment and die with the window. CDK therefore synthesized the stack as
 * if the domain had never been asked for, and CloudFormation removed the
 * alternate domain name, the certificate, the `www` distribution and the apex
 * alias records as resources no longer wanted. It took forty minutes (a
 * CloudFront distribution is disabled, propagated and only then deleted) and
 * left the apex resolving to nothing.
 *
 * Nothing about that deploy was ambiguous at synth time: the bundle on disk
 * stated `"siteOrigin": "https://chamelink.app"` while the template claimed no
 * alternate domain name at all. Nobody was looking, so now this does.
 *
 * **Absent is not the same as unchanged.** Configuration that creates
 * infrastructure and lives only in the environment turns every deploy into an
 * implicit instruction to destroy whatever the current shell does not mention,
 * and CloudFormation cannot tell that apart from a deliberate removal.
 */

export type DomainIntent = {
  /** The apex the stack was asked for, if any. */
  domainName?: string;
  /** Issue the certificate and move the site onto the name. */
  attachDomain: boolean;
  /** Reuse an existing, already-delegated hosted zone instead of creating one. */
  hostedZoneId?: string;
  /** Mint a new hosted zone — step 1 of a first cutover, and nothing else. */
  createHostedZone: boolean;
  /** The host baked into the web bundle, if it names one worth checking. */
  bundleHost?: string;
};

/**
 * The host a built bundle says it is for, or `undefined` when there is nothing
 * to check against.
 *
 * `SITE_ORIGIN` is a build-time value: it is baked into canonical URLs, the
 * JSON-LD `@id`, `robots.txt` and the editor's preview origin, and the build
 * writes it into `.build-stamp`. Reading it from there rather than from the
 * environment is deliberate — the question is what the artifact about to be
 * uploaded believes, not what this shell happens to export.
 *
 * Returned raw, CloudFront and localhost included: a domain being attached has
 * to be checked against whatever the bundle actually says, not only against a
 * host that looks custom. `undefined` means the stamp said nothing.
 */
export function bundleHostFrom(stampPath: string): string | undefined {
  if (!existsSync(stampPath)) return undefined;
  try {
    const { siteOrigin } = JSON.parse(readFileSync(stampPath, 'utf8')) as { siteOrigin?: string };
    if (!siteOrigin) return undefined;
    return new URL(siteOrigin).hostname.toLowerCase() || undefined;
  } catch {
    // A missing or corrupt stamp is the freshness guard's problem, not this
    // one's, and failing two checks over one bad file explains nothing twice.
    return undefined;
  }
}

/** Every contradiction in `intent`, each phrased as what to do about it. */
export function domainProblems(intent: DomainIntent): string[] {
  const { domainName, attachDomain, hostedZoneId, createHostedZone, bundleHost } = intent;
  const problems: string[] = [];

  if (domainName && /^https?:|\/|^www\./i.test(domainName)) {
    problems.push(
      `domain must be the bare apex — "example.com", not "${domainName}".\n` +
      '      www is added to the certificate and redirected automatically.',
    );
  }

  if (attachDomain && !domainName) {
    problems.push('attachDomain needs the name too: pass -c domain=example.com (or LINKBIO_DOMAIN) alongside it.');
  }

  if (hostedZoneId && !domainName) {
    problems.push('hostedZoneId without domain: a zone is only reached through the domain whose records it holds.');
  }

  if (hostedZoneId && !/^Z[A-Z0-9]+$/i.test(hostedZoneId)) {
    problems.push(
      `hostedZoneId should be the bare id — "Z0123456789ABCDEFGHIJ", not "${hostedZoneId}".\n` +
      '      Route 53 prints it as "/hostedzone/Z…"; strip the prefix.',
    );
  }

  if (hostedZoneId && createHostedZone) {
    problems.push(
      'hostedZoneId and createHostedZone contradict each other: the first reuses a delegated\n' +
      '      zone, the second mints one whose nameservers no registrar has been told about.',
    );
  }

  if (domainName && !hostedZoneId && !createHostedZone) {
    problems.push(
      `no hostedZoneId for ${domainName}, and createHostedZone was not asked for.\n` +
      '      Creating a hosted zone for a domain that is already delegated gives it four new\n' +
      '      nameservers the registrar knows nothing about. ACM then writes its validation\n' +
      '      record into a zone no public resolver consults, CloudFormation waits in\n' +
      '      CREATE_IN_PROGRESS until the challenge times out, and the rollback takes the\n' +
      "      distribution's alternate domain names with it.\n" +
      `      → reuse the delegated zone:\n` +
      `          aws route53 list-hosted-zones-by-name --dns-name ${domainName}\n` +
      '        then pass LINKBIO_HOSTED_ZONE_ID=<the id>\n' +
      '      → only for a domain with no zone yet, pass -c createHostedZone=1 (step 1 of the cutover).',
    );
  }

  // A CloudFront name or a localhost is the default rather than a claim on a
  // custom domain — but it is still a claim, and a stack attaching a domain
  // must not ship a bundle that names one of them.
  const claimsCustomHost = !!bundleHost && bundleHost !== 'localhost' && !bundleHost.endsWith('.cloudfront.net');

  if (claimsCustomHost && (!domainName || !attachDomain)) {
    problems.push(
      `the web bundle was built for https://${bundleHost}, but this synth attaches no custom domain.\n` +
      `      This is how ${bundleHost} lost its records once already: the bundle carried the domain,\n` +
      '      the stack did not, and CloudFormation removed the alias, the certificate, the www\n' +
      '      distribution and the apex records as resources no longer asked for.\n' +
      `      → set LINKBIO_DOMAIN=${bundleHost} and LINKBIO_ATTACH_DOMAIN=1 (with LINKBIO_HOSTED_ZONE_ID),\n` +
      '      → or, to really move the site back onto the CloudFront name, rebuild without SITE_ORIGIN first.',
    );
  } else if (domainName && attachDomain && bundleHost && domainName.toLowerCase() !== bundleHost) {
    problems.push(
      `the web bundle was built for https://${bundleHost} but the stack attaches ${domainName}.\n` +
      '      Canonical URLs, JSON-LD, robots.txt and the editor\'s preview origin would all name a\n' +
      '      host this distribution does not serve.\n' +
      `      → rebuild with SITE_ORIGIN=https://${domainName}, or deploy the domain the bundle was built for.`,
    );
  } else if (domainName && attachDomain && !bundleHost) {
    // The Windows shape of the same mistake: `SetEnvironmentVariable(name, "")`
    // deletes, so an empty SITE_ORIGIN reaches the packager as absent (trap 6)
    // and the stamp records no origin at all.
    problems.push(
      `the stack attaches ${domainName} but the web bundle states no siteOrigin at all.\n` +
      '      An unset SITE_ORIGIN reaches the packager as absent on Windows, and the bundle then\n' +
      '      carries whatever default it fell back to rather than the canonical host.\n' +
      `      → rebuild with SITE_ORIGIN=https://${domainName} (npm run deploy does the build).`,
    );
  }

  return problems;
}

export function assertDomainIntent(intent: DomainIntent): void {
  const problems = domainProblems(intent);
  if (problems.length === 0) return;

  throw new Error(
    'Refusing to synthesize a contradictory domain configuration.\n\n' +
    problems.map((p) => `  ${p}`).join('\n\n') +
    '\n\nThe domain is infrastructure, so leaving it out of a deploy is an instruction\n' +
    'to remove it — not a request to leave it alone. Pass -c skipDomainCheck=1 to\n' +
    'override, and read claude/linkbio-domain-incident.md before you do.\n',
  );
}
