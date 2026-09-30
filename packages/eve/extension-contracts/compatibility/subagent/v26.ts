import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 26 `turn.failed` events had no `terminal`; epoch 27 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Investigate the authenticated user request.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
