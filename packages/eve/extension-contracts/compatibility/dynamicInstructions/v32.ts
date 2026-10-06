import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 32 `ctx.model` was `{ id } | null`; epoch 33 makes it an
// `AgentModelSelection` that keeps `id`. Resolvers that read the id keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Answer as ${ctx.model?.id ?? "the default model"}.`,
      }),
  },
});
