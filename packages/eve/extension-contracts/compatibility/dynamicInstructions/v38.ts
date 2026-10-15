import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 38 `action.result` errors had no `name`; epoch 39 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
