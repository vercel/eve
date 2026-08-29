import { describe, expect, it } from "vitest";

import { parseCreateBody } from "#eve-channel/request.js";

const sink = {
  url: "https://parent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
  version: 1 as const,
};
const callback = {
  callId: "call-1",
  subagentName: "researcher",
  token: "parent-callback-token",
  url: "https://parent.example.com/eve/v1/callback/parent-callback-token",
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
  it("accepts activity observer configuration bound to a delegated callback", () => {
    expect(
      parseCreateBody({
        callback,
        activityObserver: { sink, workIdentity },
        message: "research this",
      }),
    ).toMatchObject({ callback, activityObserver: { sink, workIdentity } });
  });

  it("rejects activity observer configuration without a delegated callback", () => {
    const response = parseCreateBody({ activityObserver: { sink, workIdentity }, message: "hi" });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });

  it.each([
    ["callId", { ...workIdentity, callId: "other" }],
    ["name", { ...workIdentity, name: "other" }],
  ])("rejects a mismatched %s", (_field, identity) => {
    const response = parseCreateBody({
      callback,
      activityObserver: { sink, workIdentity: identity },
      message: "hi",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });

  it("rejects a sink on a different callback origin", () => {
    const response = parseCreateBody({
      callback,
      activityObserver: {
        sink: { ...sink, url: sink.url.replace("parent.example.com", "other.example.com") },
        workIdentity,
      },
      message: "hi",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });

  it("ignores additive forwarded trace policy fields", () => {
    const parsed = parseCreateBody({
      forwardedTracePolicy: {
        audience: "public",
        decision: { action: "record", recordInputs: true, recordOutputs: true },
      },
      message: "research this",
    });

    expect(parsed).not.toBeInstanceOf(Response);
    expect(parsed).not.toHaveProperty("forwardedTracePolicy");
  });
});
