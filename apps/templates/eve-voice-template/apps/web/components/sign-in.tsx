"use client";

import { LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { AuthMode } from "@/lib/setup";

export function SignIn({ authMode }: { readonly authMode: AuthMode }) {
  return (
    <div className="mx-auto mt-10 w-full max-w-sm rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Sign in to start a call</h2>
      {authMode === "vercel" ? <VercelSignIn /> : <PasswordSignIn />}
    </div>
  );
}

function VercelSignIn() {
  const [pending, setPending] = useState(false);

  return (
    <Button
      className="w-full"
      disabled={pending}
      size="lg"
      onClick={async () => {
        setPending(true);
        const result = await authClient.signIn
          .social({ callbackURL: "/", provider: "vercel" })
          .catch(() => null);
        if (!result || result.error) setPending(false);
      }}
      type="button"
    >
      {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
      Sign in with Vercel
    </Button>
  );
}

function PasswordSignIn() {
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || pending) return;

    setError(null);
    setPending(true);

    const response = await fetch("/api/password-auth/login", {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);

    if (response?.ok) {
      window.location.reload();
      return;
    }

    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setError(body?.error ?? "Unable to sign in.");
    setPending(false);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
      <input
        aria-label="Password"
        autoComplete="current-password"
        autoFocus
        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        disabled={pending}
        onChange={(event) => setPassword(event.target.value)}
        type="password"
        value={password}
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={pending} size="lg" type="submit">
        {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
        Continue
      </Button>
    </form>
  );
}
