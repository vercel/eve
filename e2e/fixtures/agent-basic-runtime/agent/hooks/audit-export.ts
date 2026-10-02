import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { auditOutbox, exportAuditEvent } from "../lib/workspace";

async function exportOrQueue(event: HookEvent, ctx: HookContext): Promise<void> {
  try {
    await exportAuditEvent(ctx.session.auth.current, event);
  } catch (error) {
    auditOutbox.update((queued) => [...queued, { eventId: event.meta.id, type: event.type }]);
    // Rethrow so eve logs the failed export. The turn keeps running.
    throw error;
  }
}

export default defineHook({
  events: {
    "turn.started": exportOrQueue,
    "step.started": exportOrQueue,
  },
});
