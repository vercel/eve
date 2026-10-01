import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 30 `turn.waiting` events had no `on`; epoch 31 adds it.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
