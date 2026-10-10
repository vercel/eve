import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 31 `turn.waiting` events had no `on`; epoch 32 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
