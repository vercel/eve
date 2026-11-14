import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// NOTION_CONNECTOR is the UID returned by Vercel Connect. The "Deploy with
// Vercel" button does not provision it. Create a connector with
// `vercel connect create mcp.notion.com --name notion`.
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Notion workspace: search and edit pages and databases.",
  auth: connect(notionConnector),
});
