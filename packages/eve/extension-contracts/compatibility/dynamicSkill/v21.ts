// Existing callbacks remain valid when the runtime supplies session.context.
import { defineDynamic, defineSkill } from "#public/skills/index.js";
export default defineDynamic({
  events: {
    "turn.started": (_, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
