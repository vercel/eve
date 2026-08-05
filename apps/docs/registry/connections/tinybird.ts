import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.tinybird.co",
  description:
    "Tinybird: query pipes and data sources, and run SQL. A token grants one Workspace, so add a connection per Workspace.",
  auth: connect({ connector: "tinybird", principalType: "app" }),
});
