import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 31 had no `history` option or `history.imported` event; epoch 32 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Investigate the authenticated request.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
