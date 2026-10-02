import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 31 `turn.started` had no `continuesTurnId`, and calls had no `cancelled` status; both
// are additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "# Evidence review\n\nCheck every claim against its source.",
      }),
  },
});
