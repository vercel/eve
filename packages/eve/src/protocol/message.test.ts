import { describe, expect, it } from "vitest";

import {
  EVE_MESSAGE_STREAM_VERSION,
  createActionResultEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createMessageReceivedEvent,
  createResultCompletedEvent,
  createStepStartedEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

describe("message stream protocol", () => {
  it("pins the stream version for timed session events", () => {
    expect(EVE_MESSAGE_STREAM_VERSION).toBe("17");
  });

  it("creates result.completed events", () => {
    expect(
      createResultCompletedEvent({
        result: { title: "Done" },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ).toEqual({
      data: {
        result: { title: "Done" },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
      type: "result.completed",
    });
  });

  it("stamps durable timing metadata and preserves it through encoding", () => {
    const timed = timestampHandleMessageStreamEvent(
      createStepStartedEvent({
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_0",
      }),
      "2026-04-17T10:14:22.123Z",
    );

    expect(timed.meta).toEqual({
      at: "2026-04-17T10:14:22.123Z",
    });

    const encoded = encodeMessageStreamEvent(timed);
    const decoded = JSON.parse(new TextDecoder().decode(encoded).trim()) as typeof timed;

    expect(decoded).toEqual(timed);
  });

  it("builds authorization.required with optional challenge and webhookUrl", () => {
    const bare = createAuthorizationRequiredEvent({
      name: "linear",
      description: "Linear",
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_0",
    });
    expect(bare).toEqual({
      type: "authorization.required",
      data: {
        name: "linear",
        description: "Linear",
        sequence: 3,
        stepIndex: 1,
        turnId: "turn_0",
      },
    });

    const webhookUrl = `https://eve.example.com${createEveConnectionCallbackRoutePath(
      "linear",
      "abc",
    )}`;
    const full = createAuthorizationRequiredEvent({
      authorization: { url: "https://idp.example.com/authorize" },
      name: "linear",
      description: "Linear",
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_0",
      webhookUrl,
    });
    expect(full.data.authorization).toEqual({
      url: "https://idp.example.com/authorize",
    });
    expect(full.data.webhookUrl).toBe(webhookUrl);
  });

  it("builds authorization.completed with optional reason", () => {
    const authorized = createAuthorizationCompletedEvent({
      name: "linear",
      outcome: "authorized",
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_0",
    });
    expect(authorized.data.reason).toBeUndefined();
    expect(authorized.data.outcome).toBe("authorized");

    const timedOut = createAuthorizationCompletedEvent({
      name: "linear",
      outcome: "timed-out",
      reason: "authorization_deadline_exceeded",
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_0",
    });
    expect(timedOut.data.reason).toBe("authorization_deadline_exceeded");
  });

  it("builds authorization.completed with the journaled challenge", () => {
    const withoutChallenge = createAuthorizationCompletedEvent({
      name: "linear",
      outcome: "authorized",
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_0",
    });
    expect(withoutChallenge.data).not.toHaveProperty("authorization");

    const withChallenge = createAuthorizationCompletedEvent({
      authorization: { displayName: "Linear", url: "https://idp.example.com/authorize" },
      name: "linear",
      outcome: "authorized",
      sequence: 7,
      stepIndex: 1,
      turnId: "turn_0",
    });
    expect(withChallenge.data.authorization).toEqual({
      displayName: "Linear",
      url: "https://idp.example.com/authorize",
    });
  });

  it("normalizes failed action results onto the event payload", () => {
    const event = createActionResultEvent({
      result: {
        callId: "call_weather",
        kind: "tool-result",
        output: '{"code":"TOOL_EXECUTION_FAILED","message":"Nope"}',
        toolName: "get_weather",
      },
      sequence: 0,
      stepIndex: 1,
      turnId: "turn_0",
    });

    expect(event.data).toEqual({
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "Nope",
      },
      result: {
        callId: "call_weather",
        kind: "tool-result",
        output: '{"code":"TOOL_EXECUTION_FAILED","message":"Nope"}',
        toolName: "get_weather",
      },
      sequence: 0,
      status: "failed",
      stepIndex: 1,
      turnId: "turn_0",
    });
  });

  it("marks denied action results as rejected", () => {
    const event = createActionResultEvent({
      rejected: true,
      result: {
        callId: "approval-call",
        isError: true,
        kind: "tool-result",
        output: { code: "TOOL_EXECUTION_DENIED", message: "Tool execution was denied." },
        toolName: "bash",
      },
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(event.data.status).toBe("rejected");
    expect(event.data.error).toEqual({
      code: "TOOL_EXECUTION_DENIED",
      message: "Tool execution was denied.",
    });
  });
});

describe("createMessageReceivedEvent parts projection", () => {
  function projectParts(message: Parameters<typeof createMessageReceivedEvent>[0]["message"]) {
    return createMessageReceivedEvent({ message, sequence: 1, turnId: "turn_1" }).data.parts;
  }

  it("projects a plain string message as a single text part", () => {
    expect(projectParts("hello")).toEqual([{ text: "hello", type: "text" }]);
  });

  it("projects text parts verbatim alongside the flattened summary", () => {
    const event = createMessageReceivedEvent({
      message: [{ text: "describe this", type: "text" }],
      sequence: 1,
      turnId: "turn_1",
    });
    expect(event.data.parts).toEqual([{ text: "describe this", type: "text" }]);
    expect(event.data.message).toBe("describe this");
  });

  it("projects inline file bytes as metadata only, never the bytes or a url", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const parts = projectParts([
      { data: bytes, filename: "report.pdf", mediaType: "application/pdf", type: "file" },
    ]);
    expect(parts).toEqual([
      { filename: "report.pdf", mediaType: "application/pdf", size: 4, type: "file" },
    ]);
    expect(parts?.[0]).not.toHaveProperty("url");
  });

  it("exposes a client-resolvable url for http(s) URL file parts", () => {
    const parts = projectParts([
      {
        data: new URL("https://example.com/a.png"),
        filename: "a.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
    expect(parts).toEqual([
      {
        filename: "a.png",
        mediaType: "image/png",
        type: "file",
        url: "https://example.com/a.png",
      },
    ]);
  });

  it("reconstitutes eve-url: serialized file parts into a url", () => {
    const parts = projectParts([
      {
        data: serializeUrlFilePart(new URL("https://files.example.com/x.pdf")),
        filename: "x.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);
    expect(parts?.[0]).toMatchObject({ url: "https://files.example.com/x.pdf" });
  });

  it("passes through a data: URL string as a url", () => {
    const data = "data:text/plain;base64,aGVsbG8=";
    const parts = projectParts([{ data, mediaType: "text/plain", type: "file" }]);
    expect(parts?.[0]).toMatchObject({ url: data });
  });

  it("exposes a plain http(s) URL string as a url", () => {
    const parts = projectParts([
      { data: "https://files.example.com/y.pdf", mediaType: "application/pdf", type: "file" },
    ]);
    expect(parts?.[0]).toMatchObject({ url: "https://files.example.com/y.pdf" });
  });

  it("never exposes an internal eve-sandbox: ref string as a url", () => {
    const parts = projectParts([
      {
        data: "eve-sandbox:?path=%2Fworkspace%2Fa.png&size=10&type=image%2Fpng",
        mediaType: "image/png",
        type: "file",
      },
    ]);
    expect(parts).toEqual([{ mediaType: "image/png", type: "file" }]);
    expect(parts?.[0]).not.toHaveProperty("url");
  });

  it("surfaces opaque base64 string data as metadata only", () => {
    const parts = projectParts([
      { data: "aGVsbG8=", filename: "note.txt", mediaType: "text/plain", type: "file" },
    ]);
    expect(parts).toEqual([{ filename: "note.txt", mediaType: "text/plain", type: "file" }]);
    expect(parts?.[0]).not.toHaveProperty("url");
  });

  it("projects sandbox refs as metadata without leaking the internal path", () => {
    const ref = encodeSandboxRef({
      mediaType: "image/png",
      path: "/workspace/attachments/abc/photo.png",
      size: 2048,
    });
    const parts = projectParts([{ data: ref, mediaType: "image/png", type: "file" }]);
    expect(parts).toEqual([
      { filename: "photo.png", mediaType: "image/png", size: 2048, type: "file" },
    ]);
    expect(JSON.stringify(parts)).not.toContain("/workspace/attachments");
  });

  it("normalizes image parts into file parts", () => {
    const parts = projectParts([
      { image: new URL("https://example.com/p.jpg"), mediaType: "image/jpeg", type: "image" },
    ]);
    expect(parts).toEqual([
      {
        filename: undefined,
        mediaType: "image/jpeg",
        type: "file",
        url: "https://example.com/p.jpg",
      },
    ]);
  });
});
