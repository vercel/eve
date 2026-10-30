import { describe, expect, it } from "vitest";

import { parseCreateBody, parseSessionMessageBody } from "#eve-channel/request.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

describe("HTTP attachment reference boundary", () => {
  it.each(["chat-sdk-file:?p=placeholder", "CHAT-SDK-FILE:?p=placeholder", "eve-url://["])(
    "rejects internal attachment marker %s on creates and follow-ups",
    (data) => {
      const payload = { message: [{ type: "file", mediaType: "image/png", data }] };
      for (const parse of [parseCreateBody, parseSessionMessageBody]) {
        const result = parse(payload);
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(400);
      }
    },
  );

  it("continues accepting ordinary attachment URLs", () => {
    const message = [
      { type: "file", mediaType: "image/png", data: "https://files.example/photo.png" },
    ];
    expect(parseCreateBody({ message })).toMatchObject({ message });
    expect(parseSessionMessageBody({ message })).toMatchObject({ message });
  });
});

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

  it.each([2, REMOTE_AGENT_PROTOCOL_VERSION])(
    "accepts a delegated protocol %s call with a retired activity observer",
    (protocolVersion) => {
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
        protocolVersion,
      });

      expect(body).toEqual(expect.objectContaining({ callback, message: "research this" }));
      expect(body).not.toHaveProperty("activityObserver");
    },
  );

  it.each([
    ["a caller on protocol 2", 2, 2],
    ["a caller on this protocol", REMOTE_AGENT_PROTOCOL_VERSION, REMOTE_AGENT_PROTOCOL_VERSION],
  ])("serves %s", (_name, sent, served) => {
    const payload: Record<string, unknown> = { callback: CALLBACK, message: "research this" };
    if (sent !== undefined) payload.protocolVersion = sent;
    const body = parseCreateBody(payload);
    expect(body).toEqual(expect.objectContaining({ callback: CALLBACK, protocolVersion: served }));
  });

  it.each([undefined, 1])(
    "rejects a protocol-1 caller before parsing its callback (%s)",
    async (protocolVersion) => {
      const body = parseCreateBody({
        callback: { ...CALLBACK, taskId: "caller-task" },
        message: "research this",
        protocolVersion,
      });
      if (!(body instanceof Response)) throw new Error("expected a refusal");
      expect(body.status).toBe(409);
      await expect(body.json()).resolves.toMatchObject({
        code: "REMOTE_AGENT_PROTOCOL_MISMATCH",
        protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
      });
    },
  );

  it.each([{}, { nextProtocolOption: true }])(
    "preserves protocol upgrade guidance with additional fields %j",
    async (additional) => {
      const body = parseCreateBody({
        ...additional,
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
    },
  );

  it.each([64, 65])("bounds message-part work before admission (%i parts)", async (count) => {
    const body = parseCreateBody({
      message: Array.from({ length: count }, () => ({ type: "text", text: "A report section." })),
    });
    if (count === 64) expect(body).not.toBeInstanceOf(Response);
    else {
      expect(body).toBeInstanceOf(Response);
      expect((body as Response).status).toBe(400);
      await expect((body as Response).json()).resolves.toMatchObject({
        error: expect.stringContaining("64"),
      });
    }
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
