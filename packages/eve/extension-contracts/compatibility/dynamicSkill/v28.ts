import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 28 `turn.failed` events had no `terminal`; epoch 29 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
