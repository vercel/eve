import { defineDynamic, defineInstructions } from "eve/instructions";

import { goal } from "./lib/state.ts";

export default defineDynamic(() => {
  const current = goal.get();
  if (current?.status !== "active") return null;
  return defineInstructions({
    content: [
      `<goal runs="${current.runs}/${current.maxRuns}">${current.objective}</goal>`,
      current.lastReason === undefined
        ? ""
        : `<last_judgement>${current.lastReason}</last_judgement>`,
      "Work toward the goal. After each turn a judge decides from what the turn surfaced whether the goal is met, so prove progress with tool output rather than claims.",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  });
});
