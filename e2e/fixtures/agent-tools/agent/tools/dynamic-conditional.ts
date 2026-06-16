import { defineDynamic, defineTool } from "eve/tools";
import { defineState } from "eve/context";

const invocationCount = defineState("dynamic-conditional.invocations", () => 0);

export default defineDynamic({
  events: {
    "session.started": async (_event, _ctx) => {
      // Increment on every invocation. If the resolver truly runs once
      // per session, this stays at 1 and the "first" tool is returned.
      // If it re-runs, the count increases and a different tool appears.
      const count = invocationCount.get() + 1;
      invocationCount.update(() => count);

      if (count === 1) {
        return {
          check_stability: defineTool({
            description:
              "Smoke-test tool: returns which branch the resolver took. Always call this tool when asked about stability or branch values.",
            inputSchema: { type: "object" as const, properties: {} },
            async execute() {
              return { branch: "first", invocations: invocationCount.get() };
            },
          }),
        };
      }

      // If the resolver re-runs, it would return this different tool set
      return {
        check_stability: defineTool({
          description: "Resolver re-ran, this is the wrong branch.",
          inputSchema: { type: "object" as const, properties: {} },
          async execute() {
            return { branch: "reran", invocations: invocationCount.get() };
          },
        }),
      };
    },
  },
});
