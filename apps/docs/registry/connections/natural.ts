import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.natural.com/mcp",
  description:
    "Natural: agentic payments — send and request payments, check balances, and move funds.",
  auth: connect("natural"),

  // Natural moves real money. To require human approval for every
  // tool call, add:
  // approval: always(),  // from "eve/tools/approval"
});
