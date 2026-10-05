import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.upstash.com/mcp",
  description:
    "Upstash: manage and query Redis, QStash, Workflow, Vector, Search, Box, and Blob resources.",
  auth: connect("upstash"),
});
