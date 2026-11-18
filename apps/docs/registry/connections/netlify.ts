import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.netlify.com/mcp",
  description: "Netlify: create, deploy, manage, and secure sites.",
  auth: connect("netlify"),
});
