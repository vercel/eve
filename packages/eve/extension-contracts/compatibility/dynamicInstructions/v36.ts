import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 36 callbacks that do not inspect a replacement predecessor remain supported.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
