import { contextStorage } from "#context/container.js";
import { HandleEventKey, SessionKey } from "#context/keys.js";
import { normalizeActivityText } from "#execution/activity-text.js";
import { logError, createLogger } from "#internal/logging.js";
import { createActionUpdatedEvent } from "#protocol/message.js";
import type { ToolActivity } from "#tools/definition.js";

const log = createLogger("execution.tool-activity");

export function createToolActivity(input: { readonly callId: string }): ToolActivity {
  return {
    async update(message) {
      const normalized = normalizeActivityText(message);
      if (normalized === "") return;
      const ctx = contextStorage.getStore();
      const emit = ctx?.get(HandleEventKey);
      const session = ctx?.get(SessionKey);
      if (emit === undefined || session === undefined) return;
      try {
        await emit(
          createActionUpdatedEvent({
            callId: input.callId,
            message: normalized,
            sequence: session.turn.sequence,
            turnId: session.turn.id,
          }),
        );
      } catch (error) {
        logError(log, "tool activity emission failed", error, { callId: input.callId });
      }
    },
  };
}
