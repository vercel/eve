import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 29 `turn.waiting` events had no `awaitingPerson`; epoch 30 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
