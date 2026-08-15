import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({
        markdown: "Answer with evidence from the current session.",
      }),
  },
});
