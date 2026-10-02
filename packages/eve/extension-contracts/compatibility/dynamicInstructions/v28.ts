import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 28 `task.settled` events had no `name` or `kind`; epoch 29 adds both as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
