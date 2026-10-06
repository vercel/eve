import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 31 `ctx.model` was `{ id } | null`; epoch 32 makes it an
// `AgentModelSelection` that keeps `id`. Resolvers that read the id keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: "Triage the active incident.",
        markdown: `Triage the incident with ${ctx.model?.id ?? "the default model"}.`,
      }),
  },
});
