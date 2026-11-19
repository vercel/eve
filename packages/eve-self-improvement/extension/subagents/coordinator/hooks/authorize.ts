import { defineHook, type HookContext } from "eve/hooks";
import { calls } from "eve/events";
import extension from "../../../extension.js";
import { authorizeCoordinator } from "../../../lib/delegation.js";
import { taskProgress } from "../../../lib/task-progress.js";

function observeTasks(ctx: HookContext) {
  const turnId = ctx.session.turn.id;
  taskProgress.update(() => ({
    turnId,
    calls: calls(ctx.view, { kind: "agent", turnId }).map((call) => ({
      name: call.name,
      state: call.state,
    })),
  }));
}

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      await authorizeCoordinator(extension.config, ctx);
    },
    "call.requested"(_event, ctx) {
      observeTasks(ctx);
    },
    "call.started"(_event, ctx) {
      observeTasks(ctx);
    },
    "call.settled"(_event, ctx) {
      observeTasks(ctx);
    },
  },
});
