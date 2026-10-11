import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 34 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 35 adds `name` to `load-skill`
// requests and requires it on results.
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
