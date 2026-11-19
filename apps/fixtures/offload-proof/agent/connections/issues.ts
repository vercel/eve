import { defineMcpClientConnection } from "eve/connections";
import { offloadSandbox } from "eve/tools";

export default defineMcpClientConnection({
  description: "Repository issues over MCP.",
  toolCall: { toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }) },
  url: "http://127.0.0.1:8787/mcp",
});
