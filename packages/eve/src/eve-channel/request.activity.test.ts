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
  it("accepts relay configuration bound to a delegated callback", () => {
    expect(
      parseCreateBody({
        callback,
        eventRelay: { sink, workIdentity },
        message: "research this",
      }),
    ).toMatchObject({ callback, eventRelay: { sink, workIdentity } });
  });

  it("rejects relay configuration without a delegated callback", () => {
    const response = parseCreateBody({ eventRelay: { sink, workIdentity }, message: "hi" });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });

  it.each([
    ["callId", { ...workIdentity, callId: "other" }],
    ["name", { ...workIdentity, name: "other" }],
  ])("rejects a mismatched %s", (_field, identity) => {
    const response = parseCreateBody({
      callback,
      eventRelay: { sink, workIdentity: identity },
      message: "hi",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });

  it("rejects a sink on a different callback origin", () => {
    const response = parseCreateBody({
      callback,
      eventRelay: {
        sink: { ...sink, url: sink.url.replace("parent.example.com", "other.example.com") },
        workIdentity,
      },
      message: "hi",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
  });
});
