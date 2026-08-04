"use client";

import { LockKeyholeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function AccessForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    const result = await authClient.signIn.staticCredentials({
      password: typeof password === "string" ? password : "",
    });

    if (result.error) {
      setError(result.error.message ?? "Unable to sign in.");
      setPending(false);
      return;
    }

    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-4">
          <span className="flex size-9 items-center justify-center rounded-full bg-muted">
            <LockKeyholeIcon className="size-4" />
          </span>
          <div className="space-y-1.5">
            <h1 className="font-medium text-xl tracking-tight">Sign in to your agent</h1>
            <p className="text-muted-foreground text-sm">
              Enter the access password configured for this deployment.
            </p>
          </div>
        </div>

        <form className="space-y-3" method="post" onSubmit={submit}>
          <div className="space-y-1.5">
            <label className="text-muted-foreground text-sm" htmlFor="password">
              Password
            </label>
            <Input
              aria-describedby={error ? "access-error" : undefined}
              autoComplete="current-password"
              autoFocus
              className="h-10 bg-card! text-sm focus-visible:border-foreground! dark:bg-card!"
              disabled={pending}
              id="password"
              name="password"
              required
              type="password"
            />
          </div>
          {error ? (
            <p className="text-destructive text-sm" id="access-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="h-10 w-full text-sm" disabled={pending} type="submit">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
