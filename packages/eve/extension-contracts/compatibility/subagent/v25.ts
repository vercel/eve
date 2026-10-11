import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 25 `task.settled` events had no `name` or `kind`; epoch 26 adds both as optional.
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
