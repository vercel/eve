// Epoch 39 had no `decline` on input responses or `declined` input outcome; epoch 40 adds
// them as optional. Authoring code that never uses them keeps working.
import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 38 `action.result` errors had no `name`; epoch 39 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
