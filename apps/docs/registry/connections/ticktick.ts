import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.ticktick.com",
  description: "TickTick: tasks, habits, and lists.",
  auth: connect("ticktick"),
});
