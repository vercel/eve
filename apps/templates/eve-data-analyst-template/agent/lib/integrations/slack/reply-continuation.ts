import { defineHook } from "eve/hooks";

import { queriesForTurn, transferQueries } from "../../analyst/query-log";
import { defineState } from "../../state";
import { visualizationReceipts } from "./visualizations/receipts";

const pendingResume = defineState<string | null>(
  "analyst.slack-reply-resume",
  () => null
);

export default defineHook({
  events: {
    "input.resolved"(event, ctx) {
      if (ctx.channel.kind !== "channel:slack") {
        return;
      }
      const continued = event.data.resolutions.some(
        (resolution) =>
          resolution.kind === "session-limit" &&
          resolution.outcome === "answered" &&
          resolution.response?.optionId === "continue"
      );
      if (!continued) {
        return;
      }
      const sourceTurnId = event.data.turnId;
      if (
        visualizationReceipts.get()?.turnId === sourceTurnId ||
        queriesForTurn(sourceTurnId).length > 0
      ) {
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
      // The resumed turn posts the reply, so it carries the SQL attachment too.
      transferQueries(sourceTurnId, resumedTurnId);
    },
  },
});
