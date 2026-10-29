import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Search and read Notion pages as the signed-in user.",
  auth: connect({ connector: "mcp.notion.com/my-agent", principalType: "user" }),
  tools: { allow: ["notion-search", "notion-fetch"] },
});
