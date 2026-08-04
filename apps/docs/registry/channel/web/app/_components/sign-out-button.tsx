"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      aria-label="Sign out"
      className="fixed top-3 right-3 z-10"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        router.refresh();
      }}
      size="icon-sm"
      title="Sign out"
      type="button"
      variant="ghost"
    >
      <LogOutIcon className="size-4" />
    </Button>
  );
}
