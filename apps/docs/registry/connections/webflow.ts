import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.webflow.com/mcp",
  description: "Webflow: CMS items, pages, assets, and sites.",
  auth: connect("webflow"),
});
