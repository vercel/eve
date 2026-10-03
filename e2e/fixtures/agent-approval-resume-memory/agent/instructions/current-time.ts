import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        content: "Current date and time: 2026-09-29T00:00:00.000Z (UTC).",
        role: "user",
      }),
  },
});
