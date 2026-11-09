import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.tavily.com/mcp",
  description: "Tavily: search the web, extract page content, crawl sites, and map URLs.",
  auth: connect("tavily"),
});
