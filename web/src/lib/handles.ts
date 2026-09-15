/**
 * Handle shape, in one place.
 *
 * The backend owns this rule — it is the thing doing the transactional claim —
 * but the same check has to exist here so a route handler can 404 an obviously
 * invalid path without a round trip, and so the settings form can say no before
 * the creator clicks. Keep both lists in step with the server's.
 */

/**
 * Paths that belong to the product, not to a creator.
 *
 * Every entry the backend reserves (api/src/domain/schema.ts, RESERVED) has to
 * appear here, or this side would wave through a handle the claim then rejects.
 * The extras are ours: paths this app serves that the backend has no opinion
 * about.
 */
export const RESERVED_HANDLES = new Set([
  // Reserved by the backend.
  "api",
  "admin",
  "www",
  "app",
  "login",
  "logout",
  "signup",
  "settings",
  "support",
  "help",
  "about",
  "terms",
  "privacy",
  "static",
  "assets",
  "r",
  "p",
  "v1",
  "health",
  // Reserved by this app.
  "pricing",
  "status",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
]);

/*
 * Copied from the backend's Handle schema (api/src/domain/schema.ts:9), which
 * is the source of truth — it is the thing doing the transactional claim. No
 * dots: a handle that only differs by a dot reads as a near-duplicate of a
 * legitimate one, and this platform is nothing but handles. Keep the two
 * identical; a stricter rule here only produces handles the form refuses and
 * the backend would have accepted.
 */
const HANDLE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

/** The backend's z.string().min(2).max(30) on the same field. */
const MIN_LENGTH = 2;
const MAX_LENGTH = 30;

export function isValidHandle(handle: string): boolean {
  if (handle.length < MIN_LENGTH || handle.length > MAX_LENGTH) return false;
  return HANDLE.test(handle);
}

export function isReserved(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

export function handleProblem(handle: string): string | null {
  const value = handle.trim().toLowerCase();
  if (value.length < MIN_LENGTH) return "Two characters at least.";
  if (value.length > MAX_LENGTH) return "Thirty characters at most.";
  if (isReserved(value)) return "This one is reserved.";
  if (!/^[a-z0-9]/.test(value)) return "Start with a letter or a number.";
  if (!/[a-z0-9]$/.test(value)) return "End with a letter or a number.";
  // Stricter than the claim itself on purpose: the backend would take "a--b",
  // but a run of separators is the cheapest way to shadow someone else's
  // handle, so the form declines to suggest it.
  if (/[_-]{2}/.test(value)) return "No two dashes or underscores in a row.";
  if (!isValidHandle(value)) return "Lowercase letters, numbers, dashes and underscores only.";
  return null;
}
