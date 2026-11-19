"use client";

import { LogOutIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { formatPhoneNumber } from "@/lib/auth/phone-number";

export function AuthenticatedAccountControl({ phoneNumber }: { readonly phoneNumber: string }) {
  const phone = formatPhoneNumber(phoneNumber);

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-border px-3 py-3.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
        <UserRoundIcon aria-hidden="true" className="size-4" />
      </span>
      <span
        className="type-supporting-body min-w-0 flex-1 truncate text-muted-foreground"
        title={phone}
      >
        {phone}
      </span>
      <Button
        aria-label="Sign out"
        className="text-muted-foreground pointer-coarse:size-10"
        size="icon"
        title="Sign out"
        type="button"
        variant="ghost"
        onClick={() => {
          void authClient.signOut().finally(() => {
            window.location.assign("/sign-in");
          });
        }}
      >
        <LogOutIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
