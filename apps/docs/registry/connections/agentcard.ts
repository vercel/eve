import { defineMcpClientConnection } from "eve/connections";
import { connect } from "@vercel/connect/eve";

export default defineMcpClientConnection({
  url: "https://mcp.agentcard.sh/mcp",
  description: "Agentcard tools and data",
  auth: connect("agentcard"),
});
