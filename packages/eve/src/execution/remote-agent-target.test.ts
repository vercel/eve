import { expect, it } from "vitest";

import { resolveRemoteAgentTarget } from "#execution/remote-agent-dispatch.js";

it("resolves an inline remote without a registry node", () => {
  const resolved = resolveRemoteAgentTarget({
    nodeId: "$channel:preview",
    registry: new Map(),
    remoteAgentName: "preview",
    target: {
      config: {
        description: "Preview",
        path: "/eve/v1/session",
        url: "https://preview.example.com",
      },
      kind: "inline",
    },
  });

  expect(resolved).toMatchObject({
    kind: "remote",
    name: "preview",
    nodeId: "$channel:preview",
    url: "https://preview.example.com",
  });
});
