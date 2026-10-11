import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.sanity.io",
  protocolVersionDiscovery: false,
  description:
    "Sanity: query content with GROQ, edit documents, inspect schemas, and manage releases.",
  auth: connect("sanity"),
});
