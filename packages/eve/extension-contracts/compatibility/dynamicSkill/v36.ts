import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 36 reached the v26 stream event types through client results; epoch 37 replaces
// them with v27 session events. Dynamic skills that don't read session events keep working.
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
