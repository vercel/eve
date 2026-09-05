import { defineTool } from "eve/tools";

export default defineTool({
  description: "The static definition shadowed by dynamic scopes.",
  inputSchema: { type: "object" },
  execute: () => "static",
});
