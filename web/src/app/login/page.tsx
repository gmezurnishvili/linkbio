import { redirect } from "next/navigation";
import { exchange, writeTokens } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/login?error=missing");

  const tokens = await exchange("/v1/auth/token", { email, password });
  if (!tokens) redirect("/login?error=denied");

  await writeTokens({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  });
  redirect("/app");
}

const MESSAGES: Record<string, string> = {
  missing: "Enter your email and password.",
  denied: "That email and password don't match an account.",
  expired: "Your session expired. Sign in again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? MESSAGES[error] ?? MESSAGES.denied : null;

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[21rem]">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.018em]">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Your pages keep serving while you're away.</p>

        <form action={signIn} className="mt-7 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-muted">Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@studio.com"
              className="h-10 rounded-desk border border-line bg-panel px-3 text-[0.9375rem] outline-none focus:border-geo"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] text-muted">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="h-10 rounded-desk border border-line bg-panel px-3 text-[0.9375rem] outline-none focus:border-geo"
            />
          </label>

          {message ? (
            <p role="alert" className="text-[0.8125rem] text-alert">
              {message}
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-1 h-10 rounded-desk bg-ink text-[0.9375rem] font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
