import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.neon.tech/mcp",
  description: "Neon: manage projects, run queries, and make schema changes.",
  auth: connect({ connector: "neon", principalType: "app" }),
});
