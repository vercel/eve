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
    <main className="flex min-h-dvh items-center justify-center bg-background px-8 text-foreground">
      <div className="flex w-full max-w-[22rem] flex-col gap-5">
        <div className="text-foreground opacity-[0.08] dark:opacity-[0.12]">
          <EveWordmark className="h-auto w-[4.875rem]" />
        </div>
        <section aria-label="Sign in" className="flex flex-col gap-2">
          <h1 className="max-w-full break-words font-medium text-sm leading-6">{AGENT_NAME}</h1>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm leading-6">
            <span className="inline-flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              Ready
            </span>
            <span aria-hidden="true" className="text-border">
              /
            </span>
            <span>Sign in to start a session</span>
          </p>
          <Button className="mt-3 w-full gap-2 text-sm" disabled={pending} onClick={signIn}>
            <svg aria-hidden="true" className="size-3 fill-current" viewBox="0 0 24 20">
              <path d="M12 0 24 20H0L12 0Z" />
            </svg>
            <span className="leading-5">{pending ? "Redirecting…" : "Continue with Vercel"}</span>
          </Button>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function EveWordmark({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 169 53"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z"
        fill="currentColor"
      />
      <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" fill="currentColor" />
    </svg>
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
