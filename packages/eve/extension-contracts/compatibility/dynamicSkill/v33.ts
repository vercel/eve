import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 33 had no `history` option or `history.imported` event; epoch 34 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "Check claims against sources.",
      }),
  },
});
