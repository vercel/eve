"use client";

import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

const AGENT_NAME = "__EVE_INIT_APP_NAME__";

export function SignIn() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function signIn() {
    setPending(true);
    setError(undefined);
    try {
      const result = await authClient.signIn.social({
        callbackURL: "/",
        provider: "vercel",
      });
      if (!result.error) return;
      setPending(false);
      setError("Sign-in failed. Try again.");
    } catch {
      setPending(false);
      setError("Sign-in failed. Try again.");
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-sm rounded-xl border bg-card p-8 text-card-foreground">
        <p className="text-muted-foreground text-sm">Sign in to</p>
        <h1 className="mt-1 max-w-full break-words font-medium text-2xl tracking-tight">
          {AGENT_NAME}
        </h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          Use your Vercel account to continue.
        </p>
        <Button className="mt-6 w-full gap-2" disabled={pending} onClick={signIn}>
          <svg aria-hidden="true" className="size-3 fill-current" viewBox="0 0 24 20">
            <path d="M12 0 24 20H0L12 0Z" />
          </svg>
          <span className="text-sm leading-5">
            {pending ? "Redirecting…" : "Continue with Vercel"}
          </span>
        </Button>
        {error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

export function AccountControl({
  email,
  image,
  name,
}: {
  readonly email: string;
  readonly image?: string | null;
  readonly name: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const initials = getInitials(name, email);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut({
        fetchOptions: {
          onError: () => setPending(false),
          onSuccess: () => window.location.assign("/"),
        },
      });
    } catch {
      setPending(false);
    }
  }

  return (
    <div className="fixed top-3 right-3 z-10">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Open account menu for ${name}`}
            className="size-9 cursor-pointer overflow-hidden rounded-full p-0"
            size="icon"
            variant="outline"
          >
            {image && !imageFailed ? (
              <img
                alt=""
                className="size-full object-cover"
                onError={() => setImageFailed(true)}
                src={image}
              />
            ) : (
              <span aria-hidden="true" className="font-medium text-xs">
                {initials}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="min-w-0 px-2 py-1.5 text-sm">
            <span className="block truncate font-medium leading-5" title={name}>
              {name}
            </span>
            <span className="block truncate text-muted-foreground leading-5" title={email}>
              {email}
            </span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer justify-between"
            disabled={pending}
            onSelect={signOut}
          >
            {pending ? "Logging out…" : "Log out"}
            <LogOutIcon aria-hidden="true" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function getInitials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0]?.[0] ?? email[0] ?? "?").toUpperCase();
}
