import { describe, expect, it } from "vitest";

import { createRemoteAgentRouteUrl } from "#execution/remote-agent-route-url.js";

describe("createRemoteAgentRouteUrl", () => {
  it("preserves a mounted remote agent base path", () => {
    expect(
      createRemoteAgentRouteUrl(
        "https://remote.example/eve/agents/researcher",
        "/eve/v1/task-input/capability",
      ),
    ).toBe("https://remote.example/eve/agents/researcher/eve/v1/task-input/capability");
  });
});
