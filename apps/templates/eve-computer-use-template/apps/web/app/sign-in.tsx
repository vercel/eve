"use client";

import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { type FormEvent, useState } from "react";

interface LoginReply {
  readonly error?: string;
  readonly challenge?: string;
  readonly bits?: number;
}

/** The number whose SHA-256 with the challenge starts with `bits` zero bits; see lib/challenge.ts. */
async function solveChallenge(challenge: string, bits: number): Promise<string> {
  const encoder = new TextEncoder();
  const batch = 2048;
  for (let start = 0; ; start += batch) {
    const hashes = await Promise.all(
      Array.from({ length: batch }, (_, offset) =>
        crypto.subtle.digest("SHA-256", encoder.encode(`${challenge}:${start + offset}`)),
      ),
    );
    const found = hashes.findIndex((hash) => zeroBits(new Uint8Array(hash)) >= bits);
    if (found !== -1) return String(start + found);
  }
}

function zeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte !== 0) return count + Math.clz32(byte) - 24;
    count += 8;
  }
  return count;
}

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
  const [status, setStatus] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length === 0 || pending) return;
    setError(null);
    setPending(true);
    const login = (extra: Record<string, string> = {}) =>
      fetch("/api/password-auth/login", {
        body: JSON.stringify({ password, ...extra }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).catch(() => null);
    let response = await login();
    let body = (await response?.json().catch(() => null)) as LoginReply | null;
    // While the app sees many failed sign-ins, it asks for a proof of work first.
    if (body?.challenge !== undefined && body.bits !== undefined) {
      setStatus("Checking this browser");
      const solution = await solveChallenge(body.challenge, body.bits);
      response = await login({ challenge: body.challenge, solution });
      body = (await response?.json().catch(() => null)) as LoginReply | null;
      setStatus(null);
    }
    if (response?.ok) return window.location.reload();
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
          {status ?? (pending ? "Signing in" : "Sign in")}
        </Button>
      </form>
      {error ? <p className="gate-error">{error}</p> : null}
    </Gate>
  );
}

/** A deployment without a long enough `EVE_COMPUTER_USE_PASSWORD` lets no one in. */
export function NotConfigured({ reason }: { readonly reason: string }) {
  return (
    <Gate>
      <h1 className="gate-title">Not configured</h1>
      <p className="gate-note">{reason}</p>
      <p className="gate-note">
        Set <code>EVE_COMPUTER_USE_PASSWORD</code> to at least 16 characters in the project&apos;s
        environment variables and redeploy. Everyone with the password shares this agent and its
        sandboxes.
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
