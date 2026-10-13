import { defineDynamic, defineMcpClientConnection, once } from "eve/connections";

import { SERVICE_TOKEN, previewBypassHeaders, selfMcpUrl } from "../../fixture";

// Resolved per session so the URL is this deployment's, not the build host's.
export default defineDynamic({
  select: once,
  render: () =>
    defineMcpClientConnection({
      description: "The Maple Street kennel agent's own tools, reached over its MCP channel.",
      forwardPrincipal: true,
      headers: { ...previewBypassHeaders(), authorization: `Bearer ${SERVICE_TOKEN}` },
      url: selfMcpUrl(),
    }),
});
