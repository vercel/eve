import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.oreilly.com/api/content-discovery/v1/mcp/",
  description: "O'Reilly: search books, courses, and learning content.",
  auth: connect("oreilly"),
});
