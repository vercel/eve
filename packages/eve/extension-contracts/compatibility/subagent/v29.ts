import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 29 `ctx.model` was `{ id } | null`, and dynamic subagents could only
// copy its id; epoch 30 also accepts `ctx.model` itself. Copying the id keeps working.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineAgent({
        description: "Research the incidents behind a metric change.",
        model: ctx.model ? ctx.model.id : "openai/gpt-5.6-sol",
      }),
  },
});
