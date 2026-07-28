import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear workspace: issues, projects, cycles, and comments.",
  auth: connect("linear"),

  // For app-scoped authentication, replace the auth block above with:
  // auth: connect({ connector: "linear", principalType: "app" }),
});
