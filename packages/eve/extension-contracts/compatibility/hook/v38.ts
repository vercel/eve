import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "authorization.required": (event, ctx) => {
      console.info("Sign-in required", { name: event.data.name, sessionId: ctx.session.id });
    },
  },
});
