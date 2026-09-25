import { defineHook } from "eve/hooks";
import { inputHookAudit } from "../../input-hook-audit";

export default defineHook({
  events: {
    "input.requested"(event, ctx) {
      inputHookAudit.update((observations) => [
        ...observations,
        {
          receiver: "hook",
          sessionId: ctx.session.id,
          requestIds: event.data.requests.map((request) => request.requestId),
        },
      ]);
    },
  },
});
