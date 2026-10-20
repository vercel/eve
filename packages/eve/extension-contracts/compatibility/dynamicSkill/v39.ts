// Epoch 39 of the dynamicSkill capability: the authoring contract of epoch 38 still compiles.
// Epoch 40 adds an optional `windows` usage field to subagent results.
import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
