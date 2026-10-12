import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 37 reached the v26 stream event types through client results; epoch 38 replaces
// them with v27 session events. Dynamic skills that don't read session events keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Review the active request.",
        markdown: `Review evidence for session ${ctx.session.id}.`,
      }),
  },
});
