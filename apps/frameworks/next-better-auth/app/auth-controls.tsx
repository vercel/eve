"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";

type AuthMode = "sign-in" | "sign-up";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [message, setMessage] = useState<string>();
  const [isPending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const name = String(form.get("name") ?? email);

    startTransition(async () => {
      setMessage(undefined);
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({ email, name, password })
          : await authClient.signIn.email({ email, password });

      if (result.error) {
        setMessage(result.error.message ?? "Authentication failed.");
        return;
      }

      router.refresh();
    });
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-heading">
        <div>
          <p className="eyebrow">Better Auth</p>
          <h1>{mode === "sign-up" ? "Create an account" : "Sign in"}</h1>
        </div>
        <button
          className="text-button"
          onClick={() => {
            setMessage(undefined);
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
          }}
          type="button"
        >
          {mode === "sign-in" ? "Need an account?" : "Already registered?"}
        </button>
      </div>
      {mode === "sign-up" ? (
        <label>
          Name
          <input autoComplete="name" name="name" required />
        </label>
      ) : null}
      <label>
        Email
        <input autoComplete="email" name="email" required type="email" />
      </label>
      <label>
        Password
        <input
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          minLength={8}
          name="password"
          required
          type="password"
        />
      </label>
      {message ? <p className="error-message">{message}</p> : null}
      <button className="primary-button" disabled={isPending} type="submit">
        {isPending ? "Working…" : mode === "sign-up" ? "Sign up" : "Sign in"}
      </button>
    </form>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className="secondary-button"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await authClient.signOut();
          router.refresh();
        });
      }}
      type="button"
    >
      {isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}
