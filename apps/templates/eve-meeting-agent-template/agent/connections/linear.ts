import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// LINEAR_CONNECTOR is the UID of a Vercel Connect connector for Linear, e.g.
// from `vercel connect create linear --connection-method api-key`.
const linearConnector = process.env.LINEAR_CONNECTOR ?? "linear";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description:
    "Linear workspace: find teams and people, and search, create, update, and comment on issues.",
  // Meeting sessions have no signed-in user, so the agent acts in Linear with
  // the connector's own credential.
  auth: connect({ connector: linearConnector, principalType: "app" }),
  // Keep the model to issue work. The instructions name these tools.
  tools: {
    allow: ["save_issue", "get_issue", "list_issues", "list_users", "list_teams", "save_comment"],
  },
});
