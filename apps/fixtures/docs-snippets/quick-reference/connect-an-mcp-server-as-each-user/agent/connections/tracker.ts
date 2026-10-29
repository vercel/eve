import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.tracker.example/mcp",
  description: "Read issues in the tracker as the signed-in user.",
  auth: connect({ connector: "mcp.tracker.example/my-agent", principalType: "user" }),
  tools: { allow: ["list_issues", "get_issue"] },
});
