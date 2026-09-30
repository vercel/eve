import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 23 authorization events had no `principalId`; it is additive.
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
