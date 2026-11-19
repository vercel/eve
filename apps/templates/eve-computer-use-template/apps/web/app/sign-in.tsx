"use client";

import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { type FormEvent, useState } from "react";

function Gate({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="brand">
        <span className="brand-mark">eve</span>
        <span aria-hidden="true" className="brand-slash">
          /
        </span>
        <span className="brand-name">Computer use</span>
      </div>
      <div className="gate-panel">{children}</div>
    </main>
  );
}

/** The shared password from `EVE_COMPUTER_USE_PASSWORD`; see apps/web/lib/setup.ts. */
export function SignIn() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length === 0 || pending) return;
    setError(null);
    setPending(true);
    const response = await fetch("/api/password-auth/login", {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch(() => null);
    if (response?.ok) return window.location.reload();
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setError(body?.error ?? "Unable to sign in.");
    setPending(false);
  };

  return (
    <Gate>
      <h1 className="gate-title">Sign in</h1>
      <form className="gate-form" onSubmit={submit}>
        <Input
          aria-label="Password"
          autoComplete="current-password"
          autoFocus
          className="gate-input"
          disabled={pending}
          onChange={(event) => setPassword(event.currentTarget.value)}
          placeholder="Password"
          type="password"
          value={password}
        />
        <Button
          className="button button-primary"
          disabled={pending || password.length === 0}
          type="submit"
        >
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
      {error ? <p className="gate-error">{error}</p> : null}
    </Gate>
  );
}

/** A deployment without `EVE_COMPUTER_USE_PASSWORD` lets no one in. */
export function NotConfigured() {
  return (
    <Gate>
      <h1 className="gate-title">Not configured</h1>
      <p className="gate-note">
        Set <code>EVE_COMPUTER_USE_PASSWORD</code> in the project&apos;s environment variables and
        redeploy. Everyone with the password shares this agent and its sandboxes.
      </p>
    </Gate>
  );
}

export function SignOut() {
  return (
    <Button
      className="button button-sm button-tertiary sign-out"
      onClick={async () => {
        await fetch("/api/password-auth/logout", { method: "POST" }).catch(() => null);
        window.location.reload();
      }}
    >
      Sign out
    </Button>
  );
}
