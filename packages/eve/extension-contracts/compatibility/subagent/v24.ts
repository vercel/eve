import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 24 tool-call action requests had no `parentCallId`; epoch 25 adds it as optional.
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
