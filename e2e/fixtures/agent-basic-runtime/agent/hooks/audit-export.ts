import { defineHook } from "eve/hooks";
import { exportAuditEvent } from "../lib/workspace";

// An unreachable audit sink makes these handlers throw. eve logs the failure and the turn continues.
export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      await exportAuditEvent(ctx.session.auth.current, event);
    },
    async "step.started"(event, ctx) {
      await exportAuditEvent(ctx.session.auth.current, event);
    },
  },
});
