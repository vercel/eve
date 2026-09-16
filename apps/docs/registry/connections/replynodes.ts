import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.replynodes.com/mcp",
  description:
    "ReplyNodes: inspect connected social channels, integration groups, and channel posting requirements.",
  auth: connect("mcp.replynodes.com/replynodes"),
  tools: { allow: ["integrationList", "groupList", "integrationSchema"] },
});
