import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "*"(event, ctx) {
      if (
        (event.type === "turn.started" || event.type === "step.started") &&
        ctx.session.auth.current?.attributes.failHookEvent === event.type
      ) {
        throw new Error("Fixture event observer failed.");
      }
    },
  },
});
