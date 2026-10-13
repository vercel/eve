import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 38 had no `history` option or `history.imported` event; epoch 39 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
