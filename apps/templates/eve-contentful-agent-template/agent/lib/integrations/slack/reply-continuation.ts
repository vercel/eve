import { interaction } from "eve/events";
import { defineHook } from "eve/hooks";

import { defineState } from "../../state";
import { visualizationReceipts } from "./visualizations/receipts";

const pendingResume = defineState<string | null>(
  "contentful.slack-reply-resume",
  () => null
);

export default defineHook({
  events: {
    "interaction.settled"(event, ctx) {
      if (ctx.channel.kind !== "channel:slack") {
        return;
      }
      const request = interaction(ctx.view, event.data.interactionId);
      const continued =
        request?.request.kind === "budget" && event.data.outcome === "accepted";
      if (!continued) {
        return;
      }
      const sourceTurnId = request?.turnId;
      if (!sourceTurnId) {
        return;
      }
      if (visualizationReceipts.get()?.turnId === sourceTurnId) {
        pendingResume.update(() => sourceTurnId);
      }
    },
    "turn.started"(event, ctx) {
      if (ctx.channel.kind !== "channel:slack") {
        return;
      }
      const sourceTurnId = pendingResume.get();
      pendingResume.update(() => null);
      if (sourceTurnId === null) {
        return;
      }
      // Only an explicit session-limit continuation transfers reply ownership.
      // Preserve delivery/failure flags so already posted replies stay posted.
      const resumedTurnId = event.data.turnId;
      visualizationReceipts.update((receipt) =>
        receipt?.turnId === sourceTurnId
          ? { ...receipt, turnId: resumedTurnId }
          : receipt
      );
    },
  },
});
