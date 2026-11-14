"use client";

import { AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Catches unexpected errors below the root layout, so the header stays usable. */
export default function ErrorPage({
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
      <AlertCircleIcon className="size-6 text-destructive" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">The page hit an unexpected error.</p>
      </div>
      <Button onClick={() => retry()} variant="outline">
        Try again
      </Button>
    </main>
  );
}
