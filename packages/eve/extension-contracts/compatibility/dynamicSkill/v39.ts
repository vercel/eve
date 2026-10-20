import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 39 had no `history` option or `history.imported` event; epoch 40 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "Check claims against sources.",
      }),
  },
});
