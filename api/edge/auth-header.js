/**
 * Viewer-request function for the control plane.
 *
 * Origin Access Control signs the origin request with SigV4 and puts the
 * signature in `Authorization`, so a viewer's bearer token in that header is
 * overwritten before the Lambda ever sees it — every authenticated request
 * would arrive looking unauthenticated. CloudFront also refuses to forward
 * `Authorization` through an origin request policy at all, which is how this
 * surfaced: `cdk synth` fails rather than deploying something broken.
 *
 * Copying it to a header CloudFront does not claim is the documented way
 * around it. `src/auth.ts` reads `x-authorization` first and falls back to
 * `authorization`, so calling the origin directly in development still works.
 */
function handler(event) {
  var req = event.request;
  var h = req.headers;

  // Never let a viewer set this directly — it is ours to write.
  delete req.headers['x-authorization'];

  if (h.authorization && h.authorization.value) {
    req.headers['x-authorization'] = { value: h.authorization.value };
  }
  return req;
}
