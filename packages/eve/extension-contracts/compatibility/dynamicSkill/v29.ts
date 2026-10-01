import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 29 `session.waiting`, `session.failed`, `session.completed`, and `turn.waiting` events had no `usage`; epoch 30 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
