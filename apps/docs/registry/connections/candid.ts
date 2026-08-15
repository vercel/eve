import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.candid.org/mcp",
  description: "Candid: research nonprofits, funders, and grants.",
  auth: connect("candid"),
});
