import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connectorUid, isConnectorAttached } from "../lib/connect.ts";

const LINEAR_CONNECTOR = connectorUid("linear");

// On once `vercel connect create linear --connection-method mcp --name
// company-brain` attaches the connector. Each person signs in with their own
// Linear account, so the agent sees only what they can see.
export default defineDynamic(async () =>
  (await isConnectorAttached(LINEAR_CONNECTOR))
    ? defineMcpClientConnection({
        url: "https://mcp.linear.app/mcp",
        description:
          "Linear: issues, projects, cycles, and their comments, for questions about planned and in-progress work.",
        auth: connect(LINEAR_CONNECTOR),
      })
    : null,
);
