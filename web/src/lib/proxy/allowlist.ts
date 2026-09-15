/**
 * What /api/proxy is allowed to forward.
 *
 * The proxy attaches the caller's access token to whatever it is handed, so
 * without this list it is a general-purpose authenticated client for the whole
 * backend: any endpoint, any method, reachable from any page on this origin
 * with the session's full authority. The dashboard only ever calls the shapes
 * below (see lib/api/client.ts), so the rest is a 404.
 *
 * Anything added to the client belongs here too, or it will 404 in the browser
 * and work server-side, which is a confusing way to find out.
 */

/** A path shape: literal segments, with "*" standing for one opaque id. */
interface Route {
  methods: readonly string[];
  segments: readonly string[];
}

const ROUTES: readonly Route[] = [
  { methods: ["GET"], segments: ["v1", "me"] },

  { methods: ["POST"], segments: ["v1", "profiles"] },
  { methods: ["GET", "PATCH"], segments: ["v1", "profiles", "*"] },
  { methods: ["POST"], segments: ["v1", "profiles", "*", "publish"] },
  { methods: ["POST"], segments: ["v1", "profiles", "*", "handle"] },
  { methods: ["POST"], segments: ["v1", "profiles", "*", "preview"] },

  { methods: ["GET"], segments: ["v1", "handles", "*"] },

  { methods: ["POST"], segments: ["v1", "profiles", "*", "blocks"] },
  { methods: ["PATCH", "DELETE"], segments: ["v1", "profiles", "*", "blocks", "*"] },
  { methods: ["POST"], segments: ["v1", "profiles", "*", "blocks", "*", "move"] },
  // A rule belongs to a block, and the whole set is replaced at once.
  { methods: ["PUT"], segments: ["v1", "profiles", "*", "blocks", "*", "rules"] },
];

/**
 * A segment that can stand in for an id. Rejecting "." and ".." here is what
 * keeps a request for /v1/profiles/../auth/token from being a request for the
 * token endpoint once the path is joined back together.
 */
function isOpaqueSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !/[/\\]/.test(segment);
}

export function isAllowedProxyPath(method: string, path: readonly string[]): boolean {
  if (!path.every(isOpaqueSegment)) return false;

  const verb = method.toUpperCase();
  return ROUTES.some(
    (route) =>
      route.methods.includes(verb) &&
      route.segments.length === path.length &&
      route.segments.every((segment, i) => segment === "*" || segment === path[i]),
  );
}
