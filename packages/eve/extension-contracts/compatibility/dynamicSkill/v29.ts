import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 29 `turn.waiting` events had no `on`; epoch 30 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
