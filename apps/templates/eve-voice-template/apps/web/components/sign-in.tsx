"use client";

import { LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { AuthMode } from "@/lib/setup";

export function SignIn({ authMode }: { readonly authMode: AuthMode }) {
  return (
    <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Sign in to start a call</h2>
      {authMode === "vercel" ? <VercelSignIn /> : <PasswordSignIn />}
    </div>
  );
}

function VercelSignIn() {
  const [pending, setPending] = useState(false);

  return (
    <button
      className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-60"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await authClient.signIn
          .social({ callbackURL: "/", provider: "vercel" })
          .catch(() => null);
        if (!result || result.error) setPending(false);
      }}
      type="button"
    >
      {pending ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
      Sign in with Vercel
    </button>
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
        className="h-11 rounded-md border border-input bg-background px-3"
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
      <button
        className="flex h-11 items-center justify-center gap-2 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
        Continue
      </button>
    </form>
  );
}
