import { defineHook } from "eve/hooks";
import { claimSession } from "@/lib/sessions/ownership";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const initiator = ctx.session.auth.initiator;
      if (!initiator) return;

      await claimSession(scopeFromPrincipal(initiator), ctx.session.id);
    },
  },
});
