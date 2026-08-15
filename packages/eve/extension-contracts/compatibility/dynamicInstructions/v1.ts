import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

/**
 * Epoch 1 resolves the per-session system prompt from `session.started`,
 * reading only the resolve context. The event envelope stays invisible to it.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const plan = ctx.session.auth.current?.attributes.plan ?? "free";
      return defineInstructions({
        markdown: `The caller is on the ${String(plan)} plan. Match the depth of your answers to it.`,
      });
    },
  },
});
