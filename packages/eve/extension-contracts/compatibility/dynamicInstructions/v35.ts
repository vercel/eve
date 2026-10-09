import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 35 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 36 adds `name` to `load-skill`
// requests and requires it on results.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
