import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 34 had no `history` option or `history.imported` event; epoch 35 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
