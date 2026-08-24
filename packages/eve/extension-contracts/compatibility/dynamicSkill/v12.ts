import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineSkill({
        description: `Release checklist for session ${ctx.session.id}.`,
        markdown: "# Release checklist\n\nConfirm the changelog before tagging.",
      }),
  },
});
