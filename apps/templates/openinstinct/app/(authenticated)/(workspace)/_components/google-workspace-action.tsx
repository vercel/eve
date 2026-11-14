"use client";

import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

export function GoogleWorkspaceAction({
  state,
}: {
  readonly state?: "connected" | "disconnected" | "unavailable";
}) {
  const update = api.googleWorkspace.update.useMutation({
    onError: () => {
      window.location.assign("/?google=unavailable");
    },
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });

  if (!state) {
    return <Badge variant="secondary">Loading…</Badge>;
  }
  if (state === "unavailable") {
    return <Badge variant="secondary">Setup required</Badge>;
  }

  const action = state === "connected" ? "disconnect" : "connect";
  return (
    <Button
      disabled={update.isPending}
      onClick={() => {
        update.mutate(action);
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {state === "connected" ? "Disconnect" : "Connect"}
    </Button>
  );
}
