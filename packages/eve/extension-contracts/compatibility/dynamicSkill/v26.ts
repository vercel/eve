import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 26 tool-call action requests had no `parentCallId`; epoch 27 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
