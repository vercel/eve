import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connectorUid, isConnectorAttached } from "../lib/connect.ts";

const PAGERDUTY_CONNECTOR = connectorUid("pagerduty");

// On once the `pagerduty/company-brain` connector is attached (see
// `instructions/pagerduty.ts` for setup). Each person signs in with their own
// PagerDuty account, so the agent sees only what they can see.
export default defineDynamic(async () =>
  (await isConnectorAttached(PAGERDUTY_CONNECTOR))
    ? defineMcpClientConnection({
        url: "https://mcp.pagerduty.com/mcp",
        description:
          "PagerDuty: who is on call, open and recent incidents, services, and escalation policies.",
        auth: connect(PAGERDUTY_CONNECTOR),
      })
    : null,
);
