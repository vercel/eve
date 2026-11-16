import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connectorUid, isConnectorAttached } from "../lib/connect.ts";

const NOTION_CONNECTOR = connectorUid("notion");

// On once `vercel connect create notion --connection-method mcp --name
// company-brain` attaches the connector. Each person signs in with their own
// Notion account, so the agent sees only what they can see.
export default defineDynamic(async () =>
  (await isConnectorAttached(NOTION_CONNECTOR))
    ? defineMcpClientConnection({
        url: "https://mcp.notion.com/mcp",
        description:
          "Company wiki in Notion: policies, runbooks, specs, and project pages. Not for Slack discussions.",
        auth: connect(NOTION_CONNECTOR),
        // A knowledge source: read, don't edit.
        tools: { allow: ["notion-search", "notion-fetch"] },
      })
    : null,
);
