import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "# Evidence review\n\nCheck every claim against its source.",
      }),
  },
});
