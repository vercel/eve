import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { SERVICE_TOKEN, previewBypassHeaders, selfMcpUrl } from "../../fixture";

// Resolved per session so the URL is this deployment's, not the build host's.
export default defineDynamic({
  events: {
    "session.started": () =>
      defineMcpClientConnection({
        description: "The Maple Street kennel agent's own tools, reached over its MCP channel.",
        forwardPrincipal: true,
        headers: { ...previewBypassHeaders(), authorization: `Bearer ${SERVICE_TOKEN}` },
        url: selfMcpUrl(),
      }),
  },
});
