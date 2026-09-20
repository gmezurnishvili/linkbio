import Link from "next/link";
import { redirect } from "next/navigation";
import { ExchangeFailure, exchange, writeTokens } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

async function register(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/signup?error=missing");
  // 8, which is what `Credentials` in the backend enforces. It used to be 10
  // here, so a password the API would have accepted was refused by the form
  // with a message quoting a different number than the docs did.
  if (password.length < 8) redirect("/signup?error=short");

  let tokens;
  try {
    tokens = await exchange("/v1/auth/register", { email, password });
  } catch (err) {
    // 409 is the one failure worth naming. Anything else is ours, not theirs.
    if (err instanceof ExchangeFailure && err.status === 409) {
      redirect("/signup?error=taken");
    }
    redirect("/signup?error=unavailable");
  }

  await writeTokens({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  });

  // Registered, but there is no page yet. Onboarding claims the handle.
  redirect("/app/new");
}

const MESSAGES: Record<string, string> = {
  missing: "Enter an email and a password.",
  short: "Eight characters at least.",
  taken: "There's already an account on this email. Sign in instead.",
  unavailable: "Couldn't create the account. Try again in a moment.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error ? MESSAGES[error] ?? MESSAGES.unavailable : null;

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[21rem]">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.018em]">Create an account</h1>
        <p className="mt-1 text-sm text-muted">You'll pick your handle next.</p>

        <form action={register} className="mt-7 flex flex-col gap-3">
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
              autoComplete="new-password"
              required
              minLength={8}
              className="h-10 rounded-desk border border-line bg-panel px-3 text-[0.9375rem] outline-none focus:border-geo"
            />
            <span className="text-[0.75rem] text-faint">Ten characters or more.</span>
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
            Create account
          </button>
        </form>

        <p className="mt-5 text-[0.8125rem] text-muted">
          Already have one?{" "}
          <Link href="/login" className="text-ink underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
