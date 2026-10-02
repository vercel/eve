import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 32 `turn.started` had no `continuesTurnId`, and calls had no `cancelled` status; both
// are additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
