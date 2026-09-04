import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review session ${ctx.session.id}.`,
        markdown: "# Review\n\nCheck each claim.",
      }),
  },
});
