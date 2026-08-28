import { randomUUID } from "node:crypto";

import { contextStorage } from "#context/container.js";
import { ActivityObserverKey } from "#context/keys.js";
import { normalizeActivityText } from "#execution/activity-text.js";
import {
  deriveActivityActionId,
  deriveRootTurnActivityWorkId,
} from "#execution/activity-work-id.js";
import { submitActivity } from "#execution/submit-activity.js";
import type { ToolActivity } from "#tools/definition.js";

export function createToolActivity(input: {
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
}): ToolActivity {
  const observer = contextStorage.getStore()?.get(ActivityObserverKey);
  const workId =
    observer?.workIdentity?.id ??
    deriveRootTurnActivityWorkId({ sessionId: input.sessionId, turnId: input.turnId });
  const actionId = deriveActivityActionId({ callId: input.callId, workId });
  return {
    async update(message) {
      const normalized = normalizeActivityText(message);
      if (observer === undefined || normalized === "") return;
      await submitActivity({
        events: [
          {
            actionId,
            eventId: `${actionId}:updated:${randomUUID()}`,
            kind: "action.updated",
            message: normalized,
            updatedAt: new Date().toISOString(),
          },
        ],
        sink: observer.sink,
      });
    },
  };
}
