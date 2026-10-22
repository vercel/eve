import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "#public/connections/index.js";

// Existing event callbacks do not opt into creator-authorized management.
export default defineMcpClientConnection({
  description: "Watch issue updates.",
  url: "https://issues.example/mcp",
  auth: connect("oauth/issues"),
  experimental_events: {
    async onEvent({ event, origin, auth, attachSession }) {
      await attachSession(origin.sessionId).send(JSON.stringify(event.data), { auth });
    },
  },
});
