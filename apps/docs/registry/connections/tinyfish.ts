import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const READ_ONLY_TOOLS = new Set([
  "batch_status",
  "fetch_content",
  "get_deep_research",
  "get_monitor",
  "get_run",
  "get_search_usage",
  "get_wallet",
  "list_browser_sessions",
  "list_fetch_usage",
  "list_monitors",
  "list_runs",
  "search",
]);

export default defineMcpClientConnection({
  url: "https://agent.tinyfish.ai/mcp",
  description:
    "TinyFish: search the web, fetch page content, and run browser automation and research.",
  auth: connect("tinyfish"),
  approval: ({ toolName }) =>
    READ_ONLY_TOOLS.has(toolName.split("__").pop() ?? toolName)
      ? "not-applicable"
      : "user-approval",
});
