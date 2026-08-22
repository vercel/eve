import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Triage incoming requests.",
        markdown: "# Triage\n\nInspect the request before acting.",
      }),
  },
});
