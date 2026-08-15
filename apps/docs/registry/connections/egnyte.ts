import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp-server.egnyte.com/mcp",
  description: "Egnyte: search, access, and analyze governed content.",
  auth: connect("egnyte"),
});
