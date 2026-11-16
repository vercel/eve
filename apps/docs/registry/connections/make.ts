import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.make.com/v2",
  description: "Make: run scenarios and manage automations.",
  auth: connect("make"),
});
