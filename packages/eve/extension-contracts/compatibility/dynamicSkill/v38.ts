// Epoch 38 had no `decline` on input responses or `declined` input outcome; epoch 39 adds
// them as optional. Authoring code that never uses them keeps working.
import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 37 `action.result` errors had no `name`; epoch 38 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
