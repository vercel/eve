// Epoch 40 of the dynamicInstructions capability: the authoring contract of epoch 39 still compiles.
// Epoch 41 adds an optional `windows` usage field to subagent results.
import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
