import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 40 model options had no `maxOutputTokens`; epoch 41 adds it as an optional field, which is additive.
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
