import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://ai.todoist.net/mcp",
  description: "Todoist: search, complete, and manage tasks.",
  auth: connect("todoist"),
});
