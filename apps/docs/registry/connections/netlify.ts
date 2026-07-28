import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://netlify-mcp.netlify.app/mcp",
  description: "Netlify: create, deploy, manage, and secure sites.",
  auth: connect("netlify"),
});
