import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircleIcon, LockIcon } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";

import { getAccessStatus, safeRedirect, signIn } from "@/app/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Password sign-in for the web chat. Visitors who already have access are sent
 * straight on to their `redirect` destination.
 */
export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    const status = await getAccessStatus();
    if (status === "open" || status === "authorized") {
      throw redirect({ href: safeRedirect(search.redirect) });
    }
    return { status };
  },
  loader: ({ context }) => context.status,
  head: () => ({ meta: [{ title: "Sign In" }] }),
  component: LoginPage,
});

/**
 * Renders the password form, or a setup notice when `EVE_ACCESS_PASSWORD` is unset.
 *
 * @returns The sign-in page.
 */
function LoginPage() {
  const status = Route.useLoaderData();
  const { redirect: target } = Route.useSearch();
  const submit = useServerFn(signIn);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  /**
   * Submits the password and, on success, reloads into the requested page.
   *
   * @param event - The form submit event.
   */
  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    if (password === null || password instanceof File || password === "") {
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      const result = await submit({ data: { password } });
      if (result.ok) {
        window.location.assign(safeRedirect(target));
        return;
      }
      setError("Incorrect password.");
    } catch {
      setError("Something went wrong. Please try again.");
    }
    setPending(false);
  };

  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-muted flex size-10 items-center justify-center rounded-full">
            <LockIcon className="text-muted-foreground size-4" />
          </span>
          <h1 className="text-2xl font-medium tracking-tight">Sign In</h1>
          <p className="text-muted-foreground text-sm">
            {status === "unconfigured"
              ? "This agent isn't accepting visitors yet."
              : "Enter the access password to chat with this agent."}
          </p>
        </div>

        {status === "unconfigured" ? (
          <p className="bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2.5 text-sm">
            Set the{" "}
            <code className="text-foreground font-mono">
              EVE_ACCESS_PASSWORD
            </code>{" "}
            environment variable in your Vercel project, then redeploy.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
          >
            <Input
              aria-invalid={error !== undefined}
              aria-label="Password"
              autoComplete="current-password"
              autoFocus
              disabled={pending}
              name="password"
              placeholder="Password"
              type="password"
            />
            {error === undefined ? null : (
              <p
                className="text-destructive flex items-center gap-2 text-sm"
                role="alert"
              >
                <AlertCircleIcon className="size-4" />
                {error}
              </p>
            )}
            <Button disabled={pending} type="submit">
              {pending ? <Spinner /> : null}
              Continue
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
