import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.pscale.dev/mcp/planetscale",
  description: "PlanetScale: query Postgres and MySQL databases.",
  auth: connect("planetscale"),
});
