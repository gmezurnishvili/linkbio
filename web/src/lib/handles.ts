/**
 * Handle shape, in one place.
 *
 * The backend owns this rule — it is the thing doing the transactional claim —
 * but the same check has to exist here so a route handler can 404 an obviously
 * invalid path without a round trip, and so the settings form can say no before
 * the creator clicks. Keep both lists in step with the server's.
 */

/** Paths that belong to the product, not to a creator. */
export const RESERVED_HANDLES = new Set([
  "app",
  "api",
  "login",
  "logout",
  "signup",
  "about",
  "pricing",
  "terms",
  "privacy",
  "support",
  "help",
  "status",
  "admin",
  "assets",
  "static",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
]);

/*
 * Separators must sit between two alphanumerics. That rules out "a..b", "a.",
 * and "-a" — shapes that read as near-duplicates of a legitimate handle and are
 * the cheapest form of impersonation on a platform where the handle is the
 * whole identity.
 */
const HANDLE = /^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){1,29}$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE.test(handle);
}

export function isReserved(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

export function handleProblem(handle: string): string | null {
  const value = handle.trim().toLowerCase();
  if (value.length < 2) return "Two characters at least.";
  if (value.length > 30) return "Thirty characters at most.";
  if (isReserved(value)) return "This one is reserved.";
  if (!/^[a-z0-9]/.test(value)) return "Start with a letter or a number.";
  if (!/[a-z0-9]$/.test(value)) return "End with a letter or a number.";
  if (/[._-]{2}/.test(value)) return "No two dots or dashes in a row.";
  if (!isValidHandle(value)) return "Letters, numbers, dots, dashes and underscores only.";
  return null;
}
