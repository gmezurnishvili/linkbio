import { notFound, redirect } from "next/navigation";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { currentAccessToken } from "@/lib/auth/session";
import { ProfileProvider } from "@/components/editor/profile-store";
import { PublishBar } from "@/components/editor/publish-bar";

export const dynamic = "force-dynamic";

export default async function ProfileLayout({
  params,
  children,
}: {
  params: Promise<{ profile: string }>;
  children: React.ReactNode;
}) {
  const { profile: profileId } = await params;
  const token = await currentAccessToken();
  if (!token) redirect("/login");

  let profile;
  let pages: { id: string; handle: string }[] = [];
  try {
    // Both in one pass. The switcher needs the list on first paint, and a
    // second round trip for it would flash a bar with no way out of this page.
    const [loaded, session] = await Promise.all([
      api.profile(profileId, { token }),
      api.session({ token }),
    ]);
    profile = loaded;
    pages = session.profiles.map((p) => ({ id: p.id, handle: p.handle }));
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) redirect("/login?error=expired");
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <ProfileProvider initial={profile}>
      <PublishBar pages={pages} />
      <main className="mx-auto max-w-[64rem] px-5 py-6">{children}</main>
    </ProfileProvider>
  );
}
