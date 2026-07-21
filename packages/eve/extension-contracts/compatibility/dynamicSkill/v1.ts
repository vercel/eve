import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": (event, ctx) => {
      void event;
      return defineSkill({
        description: `Escalation runbook for ${ctx.session.id}`,
        markdown: "# Escalation\n\nFollow the on-call runbook.",
      });
    },
  },
});
