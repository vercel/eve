import { describe, expect, it } from "vitest";

import { findRemoteAgentBinding } from "#eve-channel/support.js";

const COORDINATES = {
  callId: "call_1",
  childSessionId: "child_1",
  childStreamPath: "/eve/v1/session/parent_1/subagent/call_1/child_1/stream",
};

function parentWith(binding: Record<string, unknown> | undefined) {
  return {
    getChildBinding: async (childSessionId: string) =>
      childSessionId === COORDINATES.childSessionId && binding !== undefined
        ? {
            callId: COORDINATES.callId,
            name: "research",
            streamPath: COORDINATES.childStreamPath,
            url: "https://research.example.com",
            ...binding,
          }
        : undefined,
  };
}

describe("findRemoteAgentBinding", () => {
  it("finds the child the parent recorded for the proxy route", async () => {
    await expect(
      findRemoteAgentBinding({ ...COORDINATES, parent: parentWith({ resolverId: "node_1" }) }),
    ).resolves.toEqual({
      name: "research",
      resolverId: "node_1",
      url: "https://research.example.com",
    });
  });

  it("names the earlier protocol of a child whose stream the parent can't follow", async () => {
    await expect(
      findRemoteAgentBinding({ ...COORDINATES, parent: parentWith({ earlierProtocol: 1 }) }),
    ).resolves.toEqual({
      earlierProtocol: 1,
      name: "research",
      url: "https://research.example.com",
    });
  });

  it("finds nothing for another call's route", async () => {
    await expect(
      findRemoteAgentBinding({ ...COORDINATES, callId: "call_2", parent: parentWith({}) }),
    ).resolves.toBeUndefined();
  });
});
