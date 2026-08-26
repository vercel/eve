import { describe, expect, it } from "vitest";

import { parseCreateBody } from "#eve-channel/request.js";

const sink = {
  url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
  version: 1 as const,
};

const workIdentity = {
  callId: "call-1",
  id: "work:parent:turn-1:call-1",
  kind: "remote-agent" as const,
  name: "researcher",
  parentId: "root:parent:turn-1",
  rootSessionId: "parent",
  rootTurnId: "turn-1",
};

describe("parseCreateBody activity relay", () => {
  it("accepts private event relay configuration for a remote session launcher", () => {
    expect(
      parseCreateBody({
        eventRelay: { sink, workIdentity },
        message: "research this",
      }),
    ).toMatchObject({ eventRelay: { sink, workIdentity } });
  });

  it("rejects relay configuration without a work identity", () => {
    const response = parseCreateBody({ eventRelay: { sink }, message: "research this" });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });
});
