import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.vercel.com",
  description: "Vercel: manage projects and deployments, inspect logs, and search documentation.",
  auth: connect({
    connector: "vercel",
    instructions:
      "Authorize Vercel in your browser. On the Vercel authorization page, select the team that owns your projects, then grant access to the projects and deployments this agent should read. Deployment and log tools fail with a permission error for anything left unselected.",
  }),
});
