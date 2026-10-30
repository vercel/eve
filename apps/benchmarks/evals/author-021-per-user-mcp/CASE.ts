import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/connections",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Connect this agent to our CRM's MCP server at `https://mcp.crm.example.com/mcp`. Each person should sign in with their own CRM account, so nobody reads customer records with someone else's access. We've already registered the server in Vercel Connect; the connector UID is `conn_crm_7f3a`.",
    );
  },
});
