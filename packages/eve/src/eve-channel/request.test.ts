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

describe("reserved channel identities", () => {
  const sessionId = "wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  it("accepts reserved create identities", () => {
    expect(parseCreateBody({ message: "hello", sessionId, deliveryId: "dlv_123" })).toMatchObject({
      sessionId,
      deliveryId: "dlv_123",
    });
  });
  it.each(["bad", "wrun_81ARZ3NDEKTSV4RRFFQ69G5FAV", null, 12])(
    "rejects invalid session id %s",
    (sessionId) => {
      expect((parseCreateBody({ message: "hello", sessionId }) as Response).status).toBe(400);
    },
  );
  it.each(["", "a b", "x".repeat(201), null, 12])(
    "rejects invalid delivery id %s",
    (deliveryId) => {
      expect((parseCreateBody({ message: "hello", deliveryId }) as Response).status).toBe(400);
      expect((parseSessionMessageBody({ message: "hello", deliveryId }) as Response).status).toBe(
        400,
      );
    },
  );
  it("accepts a followup delivery id", () => {
    expect(parseSessionMessageBody({ message: "next", deliveryId: "dlv_next" })).toMatchObject({
      deliveryId: "dlv_next",
    });
  });
});
