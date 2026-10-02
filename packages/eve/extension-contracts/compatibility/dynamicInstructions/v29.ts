import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 29 `task.settled` events had no `cancel`; epoch 30 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
