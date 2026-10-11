import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 25 authorization events had no `principalId`; it is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "# Evidence review\n\nCheck every claim against its source.",
      }),
  },
});
