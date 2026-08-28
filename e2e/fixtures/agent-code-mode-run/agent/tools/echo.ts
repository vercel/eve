import { defineTool } from "eve/tools";
import { z } from "zod";

const COUNTER = Symbol.for("eve.e2e.code-mode.counter");

export default defineTool({
  description: "Echo a value and report this process's execution count.",
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.string(),
  execute({ value }) {
    const state = globalThis as typeof globalThis & { [COUNTER]?: number };
    state[COUNTER] = (state[COUNTER] ?? 0) + 1;
    return `CODEMODE:${value}:${state[COUNTER]}`;
  },
});
