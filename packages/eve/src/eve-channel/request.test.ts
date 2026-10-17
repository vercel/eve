import { describe, expect, it } from "vitest";

import { parseCreateBody, parseSessionMessageBody } from "#eve-channel/request.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

describe("parseCreateBody", () => {
  it("accepts a conversation session without a message", () => {
    expect(parseCreateBody({})).toEqual({
      callback: undefined,
      capabilities: undefined,
      context: undefined,
      outputSchema: undefined,
    });
  });

  it("accepts a delegated call from an older eve that still sends an activity observer", () => {
    const callback = {
      callId: "call-1",
      subagentName: "researcher",
      token: "parent-callback-token",
      url: "https://parent.example.com/eve/v1/callback/parent-callback-token",
    };
    const body = parseCreateBody({
      activityObserver: {
        sink: { url: "https://parent.example.com/eve/v1/activity/x", version: 1 },
      },
      callback,
      message: "research this",
      protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
    });

    expect(body).toEqual(expect.objectContaining({ callback, message: "research this" }));
    expect(body).not.toHaveProperty("activityObserver");
  });

  it("rejects an explicitly empty message", async () => {
    const response = parseCreateBody({ message: "" });
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: "Expected 'message' to be non-empty when provided.",
    });
  });

  it("rejects turn-only fields without a message", async () => {
    const response = parseCreateBody({ clientContext: "page context" });
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: expect.stringContaining("does not accept"),
    });
  });
});

describe("parseSessionMessageBody authorization decline", () => {
  it.each([
    {},
    { message: "" },
    { authorizationDecline: { attemptId: "a" }, inputResponses: [{ requestId: "q", text: "hi" }] },
  ])("rejects empty or mixed session sends %j", (body) => {
    expect(parseSessionMessageBody(body)).toBeInstanceOf(Response);
  });
  it("accepts a decline without a message", () => {
    expect(
      parseSessionMessageBody({ authorizationDecline: { attemptId: "attempt-1" } }),
    ).toMatchObject({
      authorizationDecline: { attemptId: "attempt-1" },
    });
  });
  it.each([null, {}, { attemptId: "" }, { attemptId: 4 }])(
    "rejects invalid decline %j",
    (authorizationDecline) => {
      expect(parseSessionMessageBody({ authorizationDecline })).toBeInstanceOf(Response);
    },
  );
  it("rejects a decline combined with a message", () => {
    expect(
      parseSessionMessageBody({ authorizationDecline: { attemptId: "a" }, message: "hello" }),
    ).toBeInstanceOf(Response);
  });
});
