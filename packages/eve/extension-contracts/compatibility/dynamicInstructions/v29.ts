import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 29 `turn.failed` events had no `terminal`; epoch 30 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
