import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 30 `session.waiting`, `session.failed`, `session.completed`, and `turn.waiting` events had no `usage`; epoch 31 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
