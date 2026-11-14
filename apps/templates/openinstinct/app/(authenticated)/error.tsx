"use client";

import { Button } from "@web/components/ui/button";

export default function AuthenticatedError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <div className="mx-auto grid min-h-48 w-full max-w-4xl place-content-center gap-4 px-4 py-6 text-center sm:px-6 sm:py-8">
      <div>
        <h1 className="type-card-title">Page unavailable</h1>
        <p className="type-supporting-body mt-1 text-muted-foreground">
          This page could not be loaded.
        </p>
      </div>
      <Button onClick={reset} type="button" variant="outline">
        Try again
      </Button>
    </div>
  );
}
