import { defineHook } from "eve/hooks";
import { ensureScope } from "@db/services/scope";
import { claimSession } from "@db/services/sessions";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const initiator = ctx.session.auth.initiator;
      if (!initiator) return;

      const scope = scopeFromPrincipal(initiator);
      await ensureScope(scope);
      await claimSession(scope, ctx.session.id);
    },
  },
});
