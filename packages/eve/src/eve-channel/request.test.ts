import { describe, expect, it } from "vitest";

import { parseCreateBody, parseSessionMessageBody } from "#eve-channel/request.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

describe("parseCreateBody", () => {
  it("accepts a tool stub set name with or without a message", () => {
    expect(parseCreateBody({ stubs: "two-workflows" })).toMatchObject({ stubs: "two-workflows" });
    expect(parseCreateBody({ message: "Hi", stubs: "two-workflows" })).toMatchObject({
      message: "Hi",
      stubs: "two-workflows",
    });
  });

  it("rejects a stub set name that is not a non-empty string", async () => {
    for (const stubs of ["", 3, ["two-workflows"]]) {
      const response = parseCreateBody({ stubs });
      expect(response).toBeInstanceOf(Response);
      expect(await (response as Response).json()).toEqual({
        error: "Expected 'stubs' to be a non-empty tool stub set name.",
        ok: false,
      });
    }
  });

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

describe("parseSessionMessageBody", () => {
  it("rejects a tool stub set on a later message or response", async () => {
    for (const body of [
      { message: "And now?", stubs: "two-workflows" },
      { inputResponses: [{ optionId: "approve", requestId: "r1" }], stubs: "two-workflows" },
    ]) {
      const response = parseSessionMessageBody(body);
      expect(response).toBeInstanceOf(Response);
      expect(await (response as Response).json()).toMatchObject({
        error: expect.stringContaining("'stubs' is accepted only when creating a session."),
      });
    }
  });
});
