import { defineTool } from "eve/tools";

// The static tool keeps its name when override-provider.ts returns the same name.
export default defineTool({
  description:
    "Smoke-test fixture: authored version of `override-target`. Only call when the user asks to use `override-target`.",
  inputSchema: { type: "object" as const, properties: {} },
  async execute() {
    return { source: "authored" };
  },
});
