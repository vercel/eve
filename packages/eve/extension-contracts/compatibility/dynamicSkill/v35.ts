import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 35 callbacks that do not inspect a replacement predecessor remain supported.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        deferred: true,
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
