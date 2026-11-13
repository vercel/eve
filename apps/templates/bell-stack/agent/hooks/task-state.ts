import { defineHook, type HookEvent } from "eve/hooks";

import { closeBrowserRuntime, resumeBrowserAfterHumanInput } from "../lib/browser-runtime";
import { applyTaskEvent, taskState } from "../lib/task-state";

const update = (event: HookEvent, ctx: { session: { id: string } }) =>
  taskState.update((current) => applyTaskEvent(current, event, ctx.session.id));

const cancel = async (event: HookEvent<"turn.cancelled">, ctx: { session: { id: string } }) => {
  await closeBrowserRuntime(ctx.session.id);
  update(event, ctx);
};

export default defineHook({
  events: {
    "session.started": update,
    "turn.started": update,
    "message.received": (event, ctx) => {
      taskState.update((current) => {
        const next = applyTaskEvent(current, event, ctx.session.id);
        if (next !== current && current.status === "waiting_for_user")
          resumeBrowserAfterHumanInput(ctx.session.id);
        return next;
      });
    },
    "step.started": update,
    "input.requested": update,
    "input.resolved": update,
    "turn.completed": update,
    "turn.failed": update,
    "turn.cancelled": cancel,
    "session.waiting": update,
    "session.failed": update,
    "session.completed": update,
  },
});
