import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 37 reached the v26 stream event types through client results; epoch 38 replaces
// them with v27 session events. Dynamic instructions that don't read session events keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
