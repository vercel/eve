import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.klaviyo.com/mcp",
  description:
    "Klaviyo: manage profiles, lists, segments, campaigns, flows, templates, and catalogs, and report on marketing performance.",
  auth: connect("klaviyo"),

  // Klaviyo can send campaigns and change customer data. To expose only
  // read tools, change the URL to:
  // url: "https://mcp.klaviyo.com/mcp?read-only=true",
  // To require human approval for every tool call instead, add:
  // approval: always(),  // from "eve/tools/approval"
});
