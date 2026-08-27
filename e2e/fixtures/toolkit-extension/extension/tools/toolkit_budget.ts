import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { PROVIDER } from "../lib/brand";

// Bare "budget" name — eve namespaces it per package so it can't collide with
// another extension's identically-named state.
const budget = defineState("budget", () => ({ count: 0 }));

export default defineTool({
  description:
    "Increment and read the toolkit budget counter. Call when asked to bump the toolkit budget.",
  inputSchema: z.object({}),
  async execute() {
    budget.update((state) => ({ count: state.count + 1 }));
    return { scope: PROVIDER, count: budget.get().count };
  },
});
