import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { cacheControlFor } from "@/lib/context/visitor";
import { isReserved, isValidHandle } from "@/lib/handles";
import { jsonLd } from "@/lib/site/render";

/**
 * GET /:handle/identity.json
 *
 * The same JSON-LD embedded in the page, served on its own so an agent does not
 * have to parse HTML to find out who this is and where they can be reached.
 *
 * Deliberately context-free: no geo, no device, no time rules applied. An agent
 * asking who someone is should get one stable answer, not whichever variant its
 * egress IP happens to select. That also keeps this cacheable on the handle
 * alone, with no mask involved.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle: raw } = await params;
  const handle = raw.toLowerCase();

  // Same gate as the HTML route: an obviously invalid or reserved handle is a
  // 404 here too, rather than a round trip to the backend for every bot that
  // asks /_next/identity.json.
  if (isReserved(handle) || !isValidHandle(handle)) {
    return Response.json({ error: "not found" }, { status: 404, headers: NOSNIFF });
  }

  let resolution;
  try {
    resolution = await api.resolve(handle, { at: new Date().toISOString() });
  } catch (err) {
    const status = err instanceof ApiError && err.status === 404 ? 404 : 502;
    return Response.json({ error: "unavailable" }, { status, headers: NOSNIFF });
  }

  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? new URL(request.url).origin;
  const body = jsonLd({
    resolution,
    origin,
    beaconUrl: "",
  });

  return new Response(body, {
    headers: {
      "content-type": "application/ld+json; charset=utf-8",
      "cache-control": cacheControlFor(Math.max(resolution.sMaxAge, 300)),
      "access-control-allow-origin": "*",
      ...NOSNIFF,
    },
  });
}

/**
 * This document is creator-controlled and served from the apex domain, so a
 * browser must never be allowed to sniff it into something it can execute.
 */
const NOSNIFF = { "x-content-type-options": "nosniff" };
