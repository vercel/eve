import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { DESTRUCTIVE_DENIAL, SERVICE_TOKEN, previewBypassHeaders, selfMcpUrl } from "../../fixture";

// Resolved per session so the URL is this deployment's, not the build host's.
export default defineDynamic({
  events: {
    "session.started": () =>
      defineMcpClientConnection({
        // Decides from what the MCP channel declares about each tool, not from its name.
        approval: ({ toolAnnotations }) =>
          toolAnnotations?.destructiveHint === true
            ? { reason: DESTRUCTIVE_DENIAL, type: "denied" }
            : "not-applicable",
        description: "The Maple Street kennel agent's own tools, reached over its MCP channel.",
        forwardPrincipal: true,
        headers: { ...previewBypassHeaders(), authorization: `Bearer ${SERVICE_TOKEN}` },
        url: selfMcpUrl(),
      }),
  },
});
