import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 23 approval events carried no taskId; epoch 24 adds it for approvals
// proxied from a child task. Agent definitions are unchanged.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Review the pending deployment for the authenticated user.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
