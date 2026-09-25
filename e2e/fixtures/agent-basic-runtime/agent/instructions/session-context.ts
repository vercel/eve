import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": (_, { session }) =>
      session.context.surface === "docs"
        ? defineInstructions({ content: "Application surface: docs." })
        : null,
  },
});
