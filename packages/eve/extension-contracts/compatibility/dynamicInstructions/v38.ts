import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 38 reached the v26 stream event types through client results; epoch 39 replaces
// them with v27 session events. Dynamic instructions that don't read session events keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
