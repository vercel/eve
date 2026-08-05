import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineSkill({
        description: `Summarize findings for session ${ctx.session.id}.`,
        markdown: "# Findings summary\n\nGroup findings by severity before reporting.",
      }),
  },
});
