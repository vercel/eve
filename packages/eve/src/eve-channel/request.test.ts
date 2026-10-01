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

describe("session context input", () => {
  it.each([{ value: null }, { value: [] }, { value: "docs" }, { value: 42 }])(
    "rejects a non-object context: $value",
    async ({ value: sessionContext }) => {
      const response = parseCreateBody({ sessionContext });
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
      await expect((response as Response).json()).resolves.toMatchObject({
        error: "Expected 'sessionContext' to be a JSON object.",
      });
    },
  );

  it("rejects attempts to replace context on an existing session", async () => {
    const response = parseSessionMessageBody({
      message: "Hello",
      sessionContext: { surface: "support" },
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    await expect((response as Response).json()).resolves.toMatchObject({
      error: "'sessionContext' is only accepted when creating a session.",
    });
  });
});
