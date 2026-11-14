import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { closeBrowserRuntime, resumeBrowserAfterHumanInput } from "../lib/browser-runtime";
import { applyTaskEvent, taskState } from "../lib/task-state";

const update = (event: HookEvent, ctx: HookContext) => {
  const taskEvent = {
    ...event,
    meta: { id: ctx.occurrence.idempotencyKey, at: ctx.now.toISOString() },
  };
  taskState.update((current) => applyTaskEvent(current, taskEvent, ctx.session.id));
};

export default defineHook({
  events: {
    "session.started": update,
    "turn.started": update,
    "delivery.consumed": (event, ctx) => {
      const wasWaiting = taskState.get().status === "waiting_for_user";
      update(event, ctx);
      if (wasWaiting && taskState.get().status === "running") {
        resumeBrowserAfterHumanInput(ctx.session.id);
      }
    },
    "run.started": update,
    "interaction.opened": update,
    "interaction.settled": update,
    "turn.paused": update,
    async "turn.settled"(event, ctx) {
      if (event.data.outcome === "cancelled") await closeBrowserRuntime(ctx.session.id);
      update(event, ctx);
    },
    "session.ended": update,
  },
});
