import { defineDynamic, defineTool } from "eve/tools";

export const OVERRIDE_TOKEN = "dynamic-override-ok-K2P7";

// This collision must leave the static override-target.ts tool in place.
export default defineDynamic(() => {
  return {
    "override-target": defineTool({
      description:
        "Smoke-test fixture: dynamic override of `override-target`. Only call when the user asks to use `override-target`.",
      inputSchema: { type: "object" as const, properties: {} },
      async execute() {
        return { source: "dynamic", token: OVERRIDE_TOKEN };
      },
    }),
  };
});
