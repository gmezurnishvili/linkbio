import { redirect } from "next/navigation";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { currentAccessToken } from "@/lib/auth/session";
import { Onboarding } from "@/components/editor/onboarding";

export const dynamic = "force-dynamic";

export default async function NewProfilePage() {
  const token = await currentAccessToken();
  if (!token) redirect("/login");

  // Someone who already has a page and lands here by back button or bookmark
  // should go to their page, not be asked to make a second one.
  try {
    const session = await api.session({ token });
    const first = session.profiles[0];
    if (first) redirect(`/app/${first.id}`);
    return <Onboarding suggestion={suggest(session.email)} />;
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
