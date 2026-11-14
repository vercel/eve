"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@web/components/ui/button";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      disabled={pending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
      Refresh
    </Button>
  );
}
