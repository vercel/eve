import { defineMcpClientConnection } from "#public/connections/index.js";
import { toolResultFrom } from "#public/tools/index.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

// Epoch 88 extensions narrowed connection results through an MCP connection.
const linear = defineMcpClientConnection({ description: "Linear", url: "https://mcp.linear.app" });

export function linearToolName(result: RuntimeActionResult): string | undefined {
  return toolResultFrom(result, linear)?.connectionToolName;
}
