// Existing callbacks remain valid when the runtime supplies session.context.
import { defineAgent, defineDynamic } from "#public/index.js";
export default defineDynamic({
  events: {
    "turn.started": (_, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Investigate the authenticated user's request.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
