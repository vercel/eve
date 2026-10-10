import { mcpChannel } from "eve/channels/mcp";

import { SERVICE_ID, SERVICE_TOKEN } from "../../fixture";

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
  skills: true,
  tools: true,
  // The loopback connection forwards the turn's user; only this service may.
  trustedForwarders: (forwarder) =>
    forwarder.authenticator === "e2e-fixture" && forwarder.principalId === SERVICE_ID,
});
