import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.mixpanel.com/mcp",
  description: "Mixpanel: analyze, query, and manage analytics data.",
  auth: connect("mixpanel"),
});
