import { describe, expect, it } from "vitest";
import type { UserContent } from "ai";

import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  createActionResultEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createMessageReceivedEvent,
  createResultCompletedEvent,
  createSessionWaitingEvent,
  createStepStartedEvent,
  createTurnCancelledEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";

describe("message stream protocol", () => {
  it("pins the stream version for timed session events", () => {
    expect(EVE_MESSAGE_STREAM_VERSION).toBe("19");
  });

  it("publishes the channel-local continuation token on session.waiting", () => {
    expect(createSessionWaitingEvent("slack:C1:T1")).toEqual({
      data: {
        continuationToken: "C1:T1",
        wait: "next-user-message",
      },
      type: "session.waiting",
    });
  });

  it("creates turn.cancelled events", () => {
    expect(createTurnCancelledEvent({ sequence: 2, turnId: "turn_2" })).toEqual({
      data: { sequence: 2, turnId: "turn_2" },
      type: "turn.cancelled",
    });
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

describe("createMessageReceivedEvent", () => {
  function projectParts(message: string | UserContent) {
    return createMessageReceivedEvent({ message, sequence: 1, turnId: "turn_1" }).data.parts;
  }

  it("projects a plain string message as a single text part", () => {
    expect(projectParts("hello")).toEqual([{ text: "hello", type: "text" }]);
  });

  it("projects structured text parts alongside the flattened summary", () => {
    const event = createMessageReceivedEvent({
      message: [{ text: "describe this", type: "text" }],
      sequence: 1,
      turnId: "turn_1",
    });

    expect(event.data.message).toBe("describe this");
    expect(event.data.parts).toEqual([{ text: "describe this", type: "text" }]);
  });

  it("projects mixed text and file content without embedding raw bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect(
      projectParts([
        { text: "summarize", type: "text" },
        { data: bytes, filename: "report.pdf", mediaType: "application/pdf", type: "file" },
      ]),
    ).toEqual([
      { text: "summarize", type: "text" },
      { filename: "report.pdf", mediaType: "application/pdf", size: 4, type: "file" },
    ]);
  });

  it("projects tagged inline data as metadata only", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const parts = projectParts([
      {
        data: { data: bytes, type: "data" },
        filename: "inline.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ] as UserContent);

    expect(parts).toEqual([
      {
        filename: "inline.bin",
        mediaType: "application/octet-stream",
        size: 3,
        type: "file",
      },
    ]);
    expect(parts?.[0]).not.toHaveProperty("url");
  });

  it("exposes client-resolvable URL file parts", () => {
    expect(
      projectParts([
        {
          data: new URL("https://example.com/a.png"),
          filename: "a.png",
          mediaType: "image/png",
          type: "file",
        },
      ]),
    ).toEqual([
      {
        filename: "a.png",
        mediaType: "image/png",
        type: "file",
        url: "https://example.com/a.png",
      },
    ]);
  });

  it("exposes data URLs but not opaque base64 strings", () => {
    const dataUrl = "data:text/plain;base64,aGVsbG8=";

    expect(projectParts([{ data: dataUrl, mediaType: "text/plain", type: "file" }])).toEqual([
      { mediaType: "text/plain", type: "file", url: dataUrl },
    ]);
    expect(
      projectParts([
        { data: "aGVsbG8=", filename: "note.txt", mediaType: "text/plain", type: "file" },
      ]),
    ).toEqual([{ filename: "note.txt", mediaType: "text/plain", type: "file" }]);
  });

  it("exposes tagged URL file data", () => {
    expect(
      projectParts([
        {
          data: { type: "url", url: new URL("https://files.example.com/report.pdf") },
          filename: "report.pdf",
          mediaType: "application/pdf",
          type: "file",
        },
      ] as UserContent),
    ).toEqual([
      {
        filename: "report.pdf",
        mediaType: "application/pdf",
        type: "file",
        url: "https://files.example.com/report.pdf",
      },
    ]);
  });

  it("unwraps serialized eve-url refs only when the wrapped URL is client-resolvable", () => {
    expect(
      projectParts([
        {
          data: serializeUrlFilePart(new URL("https://files.example.com/x.pdf")),
          filename: "x.pdf",
          mediaType: "application/pdf",
          type: "file",
        },
      ]),
    ).toEqual([
      {
        filename: "x.pdf",
        mediaType: "application/pdf",
        type: "file",
        url: "https://files.example.com/x.pdf",
      },
    ]);
    expect(
      projectParts([
        {
          data: "eve-url:eve-sandbox:?path=%2Fworkspace%2Fsecret.png&size=10&type=image%2Fpng",
          mediaType: "image/png",
          type: "file",
        },
      ]),
    ).toEqual([{ mediaType: "image/png", type: "file" }]);
  });

  it("projects sandbox refs without leaking internal paths", () => {
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
    expect(
      projectParts([
        { image: new URL("https://example.com/p.jpg"), mediaType: "image/jpeg", type: "image" },
      ]),
    ).toEqual([
      {
        mediaType: "image/jpeg",
        type: "file",
        url: "https://example.com/p.jpg",
      },
    ]);
  });
});
