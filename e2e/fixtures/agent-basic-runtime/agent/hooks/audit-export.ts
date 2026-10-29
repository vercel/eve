import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { auditOutbox, exportAuditEvent } from "../lib/workspace";

async function exportOrQueue(event: HookEvent, ctx: HookContext): Promise<void> {
  try {
    await exportAuditEvent(ctx.session.auth.current, event);
  } catch (error) {
    auditOutbox.update((queued) => [
      ...queued,
      { position: `${ctx.position.line}:${ctx.position.index}`, type: event.type },
    ]);
    // An observer that mustn't fail the turn catches its own errors: a hook that throws during a
    // turn fails it.
    console.warn("audit export failed; queued for later", {
      error: error instanceof Error ? error.message : String(error),
      type: event.type,
    });
  }
}

export default defineHook({
  events: {
    "turn.started": exportOrQueue,
    "model.started": exportOrQueue,
  },
});
