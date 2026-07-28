import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.wix.com/mcp",
  description: "Wix: manage and build sites and apps.",
  auth: connect("wix"),
});
