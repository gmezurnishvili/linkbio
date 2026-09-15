"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { handleProblem } from "@/lib/handles";
import { Button, Chip, Field, Input } from "@/components/ui/primitives";

/**
 * One screen, one decision: the handle.
 *
 * Everything else about a page can be changed later without consequence, but
 * the handle is the thing that ends up printed on a poster, so it gets asked
 * for on its own. Availability is checked as they type, and the profile and
 * the claim happen in the same transaction server-side — two calls would leave
 * a profile with no handle if the second one lost a race.
 */
export function Onboarding({ suggestion }: { suggestion: string }) {
  const router = useRouter();
  const [handle, setHandle] = useState(suggestion);
  const [displayName, setDisplayName] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = handleProblem(handle);

  useEffect(() => {
    if (problem) {
      setAvailable(null);
      return;
    }
    const value = handle.trim().toLowerCase();
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api.checkHandle(value);
        if (!live) return;
        setAvailable(result.available);
        setTaken(result.available ? null : result.reason ?? "taken");
      } catch {
        if (live) setAvailable(null);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [handle, problem]);

  async function create() {
    setCreating(true);
    setFailure(null);
    try {
      const profile = await api.createProfile({
        handle: handle.trim().toLowerCase(),
        displayName: displayName.trim() || handle.trim(),
      });
      router.replace(`/app/${profile.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        window.location.href = "/login?error=expired";
        return;
      }
      // Someone claimed it between the check and the submit. Rare, and the
      // only correct response is to say so and let them pick again.
      setFailure(
        err instanceof ApiError && err.status === 409
          ? "Someone just claimed that one. Try another."
          : "Couldn't create the page. Try again in a moment.",
      );
      setAvailable(false);
      setCreating(false);
    }
  }

  const reasons: Record<string, string> = {
    taken: "Someone has this one.",
    reserved: "This one is reserved.",
    // The form's own check catches almost every one of these first; this is
    // for the handful where the backend's rule is stricter than ours.
    invalid: "Lowercase letters, numbers, dashes and underscores only.",
    tombstoned:
      "Recently released. It stays held for 90 days so old links don't land on a stranger's page.",
  };

  return (
    <main className="mx-auto max-w-[24rem] px-6 py-16">
      <h1 className="text-[1.375rem] font-semibold tracking-[-0.018em]">Pick your handle</h1>
      <p className="mt-1 text-sm text-muted">
        This is the address people will type. You can change it later, and the old one
        keeps working for 90 days.
      </p>

      <div className="mt-7 flex flex-col gap-4">
        <Field
          label="Handle"
          error={
            problem ??
            failure ??
            (available === false ? reasons[taken ?? "taken"] : undefined)
          }
        >
          <div className="flex items-center gap-2">
            <span className="text-[0.8125rem] text-muted">/</span>
            <Input
              value={handle}
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) =>
                setHandle(e.target.value.replace(/[^a-z0-9._-]/gi, "").toLowerCase())
              }
              placeholder="giorgi"
            />
            {available === true ? <Chip tone="live">free</Chip> : null}
          </div>
        </Field>

        <Field label="Name" hint="Shown above your links. Leave it and we'll use the handle.">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Giorgi"
          />
        </Field>

        <div>
          <Button
            variant="primary"
            onClick={() => void create()}
            disabled={Boolean(problem) || available !== true || creating}
          >
            {creating ? "Creating" : "Create my page"}
          </Button>
        </div>
      </div>
    </main>
  );
}
