import { redirect } from "next/navigation";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { currentAccessToken } from "@/lib/auth/session";
import { Onboarding } from "@/components/editor/onboarding";

export const dynamic = "force-dynamic";

export default async function NewProfilePage() {
  const token = await currentAccessToken();
  if (!token) redirect("/login");

  // This used to redirect away the moment a profile existed, which made a
  // second page unreachable — the backend has modelled many profiles per user
  // since it was written, `/v1/me` returns the array, and the only thing
  // stopping anyone from having two was this redirect.
  try {
    const session = await api.session({ token });
    return (
      <Onboarding
        suggestion={session.profiles.length === 0 ? suggest(session.email) : ""}
        // Somewhere to go if they opened this by mistake, which is the real
        // thing the old redirect was protecting against.
        backTo={session.profiles[0] ? `/app/${session.profiles[0].id}` : null}
        nth={session.profiles.length + 1}
      />
    );
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) redirect("/login?error=expired");
    throw err;
  }
}

/** A starting point from the email local part, not a decision. */
function suggest(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 30) : "";
}
