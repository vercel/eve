import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "*"(event, ctx) {
      if (
        (event.type === "turn.started" || event.type === "step.started") &&
        ctx.session.auth.current?.attributes.cancelHookEvent === event.type
      ) {
        ctx.cancel();
      }
    },
  },
});
