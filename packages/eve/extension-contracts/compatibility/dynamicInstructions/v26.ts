import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 26 authorization events had no `principalId`; it is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
