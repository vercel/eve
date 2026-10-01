import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 30 `turn.waiting` events had no `on`; epoch 31 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
