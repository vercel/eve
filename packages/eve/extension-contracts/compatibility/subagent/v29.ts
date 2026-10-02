import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 29 `turn.started` had no `continuesTurnId`, and calls had no `cancelled` status; both
// are additive.
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
