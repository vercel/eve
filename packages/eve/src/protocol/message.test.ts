import { describe, expect, it } from "vitest";
import type { UserContent } from "ai";

import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  createActionPartialEvent,
  createActionResultEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createContextClearedEvent,
  createInputResolvedEvent,
  createMessageAppendedEvent,
  createMessageReceivedEvent,
  createReasoningAppendedEvent,
  createResultCompletedEvent,
  createSessionWaitingEvent,
  createStepStartedEvent,
  createSubagentCalledEvent,
  createTurnCancelledEvent,
  createTurnInterruptedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import {
  normalizeMessageStreamEvent,
  normalizePersistedMessageStreamEvent,
  type MessageStreamEventForVersion,
} from "#protocol/message-version.js";
import { isEventId } from "#protocol/event-id.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";

describe("message stream protocol", () => {
  it("pins the stream version for timed session events", () => {
    expect(EVE_MESSAGE_STREAM_VERSION).toBe("25");
  });

  it.each(["21", "22", "23", "24"] as const)(
    "normalizes v%s cumulative appends into the v25 delta contract",
    (version) => {
      const legacyMessage = {
        data: {
          messageDelta: "lo",
          messageSoFar: "Hello",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: { at: "2026-09-02T00:00:00.000Z", id: "evt_legacy_message" },
        type: "message.appended",
      } satisfies MessageStreamEventForVersion<typeof version>;
      const legacyReasoning = {
        data: {
          reasoningDelta: "ink",
          reasoningSoFar: "think",
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: { at: "2026-09-02T00:00:00.001Z", id: "evt_legacy_reasoning" },
        type: "reasoning.appended",
      } satisfies MessageStreamEventForVersion<typeof version>;

      expect(normalizeMessageStreamEvent(version, legacyMessage)).toEqual({
        data: {
          messageDelta: "lo",
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: legacyMessage.meta,
        type: "message.appended",
      });
      expect(normalizePersistedMessageStreamEvent(legacyReasoning)).toEqual({
        data: {
          reasoningDelta: "ink",
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: legacyReasoning.meta,
        type: "reasoning.appended",
      });
    },
  );

  it("normalizes v24 tool-input appends into plain deltas", () => {
    const legacy = {
      data: {
        callId: "call_1",
        inputTextDelta: "lo",
        inputTextOffset: 3,
        sequence: 4,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      },
      meta: { at: "2026-09-02T00:00:00.001Z", id: "evt_legacy_input" },
      type: "action.input.appended",
    } satisfies MessageStreamEventForVersion<"24">;

    expect(normalizeMessageStreamEvent("24", legacy)).toEqual({
      data: {
        callId: "call_1",
        inputTextDelta: "lo",
        sequence: 4,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      },
      meta: legacy.meta,
      type: "action.input.appended",
    });
  });

  it("strips repeated v24 zero offsets without adding stream markers", () => {
    const normalize = (inputTextDelta: string) => {
      const event = normalizeMessageStreamEvent("24", {
        data: {
          callId: "call_1",
          inputTextDelta,
          inputTextOffset: 0,
          sequence: 4,
          stepIndex: 0,
          toolName: "render",
          turnId: "turn_1",
        },
        meta: { at: "2026-09-02T00:00:00.001Z", id: `evt_${inputTextDelta.length}` },
        type: "action.input.appended",
      });
      if (event.type !== "action.input.appended") {
        throw new TypeError(`Expected an action input append, received ${event.type}.`);
      }
      return event;
    };

    expect(normalize("").data).toEqual({
      callId: "call_1",
      inputTextDelta: "",
      sequence: 4,
      stepIndex: 0,
      toolName: "render",
      turnId: "turn_1",
    });
    expect(normalize("{").data).toEqual({
      callId: "call_1",
      inputTextDelta: "{",
      sequence: 4,
      stepIndex: 0,
      toolName: "render",
      turnId: "turn_1",
    });
  });

  it("rejects append variants that contradict their declared stream version", () => {
    const v24ToolInput = {
      data: {
        callId: "call_1",
        inputTextDelta: "{",
        inputTextOffset: 0,
        sequence: 4,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_1",
      },
      meta: { at: "2026-09-02T00:00:00.001Z", id: "evt_v24_input" },
      type: "action.input.appended",
    } satisfies MessageStreamEventForVersion<"24">;
    const hybridV25 = {
      data: {
        messageDelta: "Hel",
        messageSoFar: "Hel",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
      meta: { at: "2026-09-02T00:00:00.000Z", id: "evt_hybrid" },
      type: "message.appended",
    };
    const parseWireEvent = <Version extends "23" | "25">(
      event: object,
    ): MessageStreamEventForVersion<Version> =>
      JSON.parse(JSON.stringify(event)) as MessageStreamEventForVersion<Version>;

    expect(() => normalizeMessageStreamEvent("23", parseWireEvent<"23">(v24ToolInput))).toThrow(
      "Invalid action input append for stream version 23.",
    );
    expect(() => normalizeMessageStreamEvent("25", parseWireEvent<"25">(hybridV25))).toThrow(
      "Invalid message append shape for stream version 25.",
    );
  });

  it("rejects a v25 append without its delta", () => {
    const malformed = JSON.parse(
      JSON.stringify({
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: { at: "2026-09-02T00:00:00.000Z", id: "evt_malformed" },
        type: "message.appended",
      }),
    ) as MessageStreamEventForVersion<"25">;

    expect(() => normalizeMessageStreamEvent("25", malformed)).toThrow(
      "Invalid message append delta for stream version 25.",
    );
  });

  it("creates authoritative input resolution batches", () => {
    expect(
      createInputResolvedEvent({
        resolutions: [
          {
            kind: "question",
            outcome: "answered",
            requestId: "request-1",
            response: { requestId: "request-1", text: "Ship it" },
          },
          {
            kind: "tool-approval",
            outcome: "ignored",
            requestId: "request-2",
          },
        ],
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-1",
      }),
    ).toEqual({
      data: {
        resolutions: [
          {
            kind: "question",
            outcome: "answered",
            requestId: "request-1",
            response: { requestId: "request-1", text: "Ship it" },
          },
          {
            kind: "tool-approval",
            outcome: "ignored",
            requestId: "request-2",
          },
        ],
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-1",
      },
      type: "input.resolved",
    });
  });

  it("creates preliminary tool-result snapshots", () => {
    expect(
      createActionPartialEvent({
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "collecting" },
          toolName: "build_report",
        },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ).toEqual({
      data: {
        result: {
          callId: "call_1",
          kind: "tool-result",
          output: { phase: "collecting" },
          toolName: "build_report",
        },
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
      type: "action.partial",
    });
  });

  it("authors local and remote child stream paths", () => {
    const input = {
      callId: "call/1",
      childSessionId: "child/1",
      name: "research",
      sequence: 1,
      sessionId: "parent/1",
      toolName: "research",
      turnId: "turn_1",
      workflowId: "workflow_1",
    };

    expect(createSubagentCalledEvent(input).data.childStreamPath).toBe(
      "/eve/v1/session/child%2F1/stream",
    );
    expect(
      createSubagentCalledEvent({
        ...input,
        remote: { resolverId: "remote/research", url: "https://remote.example" },
      }).data,
    ).toMatchObject({
      childStreamPath: "/eve/v1/session/parent%2F1/subagents/call%2F1/child%2F1/stream",
      remote: { resolverId: "remote/research", url: "https://remote.example" },
    });
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

  it("creates turn.interrupted events without an idle event", () => {
    expect(createTurnInterruptedEvent({ sequence: 2, turnId: "turn_2" })).toEqual({
      data: { sequence: 2, turnId: "turn_2" },
      type: "turn.interrupted",
    });
  });

  it("creates context.cleared events", () => {
    expect(
      createContextClearedEvent({ sequence: 2, sessionId: "session_1", turnId: "turn_2" }),
    ).toEqual({
      data: { sequence: 2, sessionId: "session_1", turnId: "turn_2" },
      type: "context.cleared",
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

  it("stamps durable envelope metadata and preserves it through encoding", () => {
    const stamped = stampMessageStreamEvent(
      createStepStartedEvent({
        modelId: "openai/gpt-5.5",
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_0",
      }),
    );

    expect(isEventId(stamped.meta.id)).toBe(true);
    expect(stamped.meta.at).toBe(new Date(stamped.meta.at).toISOString());

    const encoded = encodeMessageStreamEvent(stamped);
    const decoded = JSON.parse(new TextDecoder().decode(encoded).trim()) as typeof stamped;

    expect(decoded).toEqual(stamped);
  });

  it("keeps encoded text append bytes linear as streams grow", () => {
    const encodedBytes = (chunkCount: number): number => {
      const delta = "x".repeat(40);
      let bytes = 0;

      for (let index = 0; index < chunkCount; index += 1) {
        const events = [
          createMessageAppendedEvent({
            messageDelta: delta,
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_0",
          }),
          createReasoningAppendedEvent({
            reasoningDelta: delta,
            sequence: 0,
            stepIndex: 0,
            turnId: "turn_0",
          }),
        ];

        for (const event of events) {
          bytes += encodeMessageStreamEvent(stampMessageStreamEvent(event)).byteLength;
        }
      }

      return bytes;
    };

    const halfStreamBytes = encodedBytes(250);
    const fullStreamBytes = encodedBytes(500);

    expect(fullStreamBytes / halfStreamBytes).toBeLessThan(2.1);
  });

  it("mints a distinct id for each emission of an identical payload", () => {
    const event = createStepStartedEvent({
      modelId: "openai/gpt-5.5",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(stampMessageStreamEvent(event).meta.id).not.toBe(stampMessageStreamEvent(event).meta.id);
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
      "attempt-1",
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
