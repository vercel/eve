import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 27 `task.settled` events had no `name` or `kind`; epoch 28 adds both as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
