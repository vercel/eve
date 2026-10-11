import { defineHook } from "#public/hooks/index.js";

// Epoch 34 `task.settled` events had no `cancel`; epoch 35 adds it as optional.
// Hooks that read only `status` still see `"cancelled"`.
export default defineHook({
  events: {
    "task.settled"(event, ctx) {
      console.info("task settled", {
        sessionId: ctx.session.id,
        status: event.data.status,
        taskId: event.data.taskId,
      });
    },
  },
});
