import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.miro.com/",
  description: "Miro: read and create content on boards.",
  auth: connect("miro"),
});
