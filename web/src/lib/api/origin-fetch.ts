/**
 * Every server-side call this app makes to the API goes through here.
 *
 * The API is a Lambda function URL with `authType: NONE`. That is not laxness:
 * Origin Access Control signs origin requests, and a signed request to a
 * function URL must carry the SHA-256 of its own body in
 * `x-amz-content-sha256` — computed by the viewer, because CloudFront does not
 * hash the body, and Lambda refuses `UNSIGNED-PAYLOAD`. A browser cannot do
 * that, so with OAC in front every form post and every click beacon is a 403.
 *
 * What keeps the function URL from being a way around the WAF is a secret
 * CloudFront adds as a custom origin header, which overwrites anything a viewer
 * sent under that name. This app calls the API directly rather than looping
 * back through the CDN, so it presents the same secret itself.
 *
 * Direct rather than through CloudFront on purpose: the loop would need the
 * distribution's own domain in the Lambda's environment, and the distribution
 * already names that Lambda as an origin, so CloudFormation refuses the cycle.
 * It would also bill a CDN request and add a public round trip to every
 * dashboard call.
 */

/** Set by the stack when a secret was supplied; empty everywhere else. */
const ORIGIN_SECRET = process.env.ORIGIN_SECRET;

export async function originFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!ORIGIN_SECRET) return fetch(url, init);

  const headers = new Headers(init.headers);
  headers.set("x-origin-secret", ORIGIN_SECRET);
  return fetch(url, { ...init, headers });
}
