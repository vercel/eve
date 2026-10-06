import { mcpChannel } from "eve/channels/mcp";

import { REQUEST_STATE_SECRET, SERVICE_ID, SERVICE_TOKEN } from "../../fixture";

export default mcpChannel({
  auth: (request) =>
    request.headers.get("authorization") === `Bearer ${SERVICE_TOKEN}`
      ? {
          attributes: {},
          authenticator: "e2e-fixture",
          principalId: SERVICE_ID,
          principalType: "service",
        }
      : null,
  requestStateSecret: REQUEST_STATE_SECRET,
  tools: true,
});
