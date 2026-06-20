import { defineTool } from "eve/tools";

// Authored tool whose name a `namespace: false` dynamic resolver
// (override-provider.ts) also emits — the dynamic version must win, so this
// `source: "authored"` result should never reach the model.
export default defineTool({
  description:
    "Smoke-test fixture: authored version of `override-target`. Only call when the user asks to use `override-target`.",
  inputSchema: { type: "object" as const, properties: {} },
  async execute() {
    return { source: "authored" };
  },
});
