"use client";

import { AlertCircleIcon } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { login, type LoginState } from "./actions";

export function LoginForm({ next }: { readonly next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={action} className="flex flex-col gap-4">
      <input name="next" type="hidden" value={next} />
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          aria-invalid={state.error ? true : undefined}
          autoComplete="current-password"
          autoFocus
          id="password"
          name="password"
          required
          type="password"
        />
      </div>
      {state.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <AlertCircleIcon className="size-4 shrink-0" />
          {state.error}
        </p>
      ) : null}
      <Button className="w-full" disabled={pending} type="submit">
        {pending ? <Spinner /> : null}
        {pending ? "Signing In…" : "Sign In"}
      </Button>
    </form>
  );
}
