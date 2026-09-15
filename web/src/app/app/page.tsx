import { redirect } from "next/navigation";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { currentAccessToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardEntry() {
  const token = await currentAccessToken();
  if (!token) redirect("/login");

  try {
    const session = await api.session({ token });
    const first = session.profiles[0];
    if (!first) redirect("/app/new");
    redirect(`/app/${first.id}`);
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) redirect("/login?error=expired");
    throw err;
  }
}
