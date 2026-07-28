import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.clickhouse.cloud/mcp",
  description: "ClickHouse Cloud: query and explore databases and tables.",
  auth: connect("clickhouse"),
});
