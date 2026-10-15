import { describe, expect, it } from "vitest";

import { parseCreateBody } from "#eve-channel/request.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

const CALLBACK = {
  callId: "call-1",
  subagentName: "researcher",
  token: "parent-callback-token",
  url: "https://parent.example.com/eve/v1/callback/parent-callback-token",
};

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

  it.each([
    ["an eve 0.66–0.68 caller, which sends no version", undefined, 1],
    ["a caller on protocol 2", 2, 2],
    ["a caller on this protocol", REMOTE_AGENT_PROTOCOL_VERSION, REMOTE_AGENT_PROTOCOL_VERSION],
  ])("serves %s", (_name, sent, served) => {
    const payload: Record<string, unknown> = { callback: CALLBACK, message: "research this" };
    if (sent !== undefined) payload.protocolVersion = sent;
    const body = parseCreateBody(payload);
    expect(body).toEqual(expect.objectContaining({ callback: CALLBACK, protocolVersion: served }));
  });

  it("drops the background task id an eve 0.66–0.68 caller names on its callback", () => {
    const body = parseCreateBody({
      callback: { ...CALLBACK, taskId: "caller-task" },
      message: "research this",
    });
    expect(body).toEqual(expect.objectContaining({ callback: CALLBACK, protocolVersion: 1 }));
  });

  it("refuses a caller on a newer protocol with this deployment's version", async () => {
    const body = parseCreateBody({
      callback: CALLBACK,
      message: "research this",
      protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION + 1,
    });
    if (!(body instanceof Response)) throw new Error("expected a refusal");
    expect(body.status).toBe(409);
    await expect(body.json()).resolves.toMatchObject({
      code: "REMOTE_AGENT_PROTOCOL_MISMATCH",
      protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
    });
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
