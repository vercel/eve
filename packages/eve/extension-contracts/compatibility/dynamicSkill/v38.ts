// Epoch 38 of the dynamicSkill capability: the authoring contract of epoch 37 still compiles.
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
