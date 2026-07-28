import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.posthog.com/mcp",
  description: "PostHog: insights, events, and feature flags.",
  auth: connect("posthog"),
});
