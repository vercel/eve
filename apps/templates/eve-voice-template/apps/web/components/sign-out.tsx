"use client";

import { authClient } from "@/lib/auth-client";
import type { AuthMode } from "@/lib/setup";

export function SignOut({ authMode }: { readonly authMode: AuthMode }) {
  if (authMode === "local-dev") return null;

  return (
    <button
      className="text-sm text-muted-foreground hover:text-foreground"
      onClick={async () => {
        if (authMode === "vercel") {
          await authClient.signOut();
        } else {
          await fetch("/api/password-auth/logout", { method: "POST" });
        }
        window.location.reload();
      }}
      type="button"
    >
      Sign out
    </button>
  );
}
