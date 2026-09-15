import { describe, expect, it } from "vitest";

import { invocationToTask, messageText, parseClientMessage } from "#internal/a2a/protocol.js";

describe("A2A protocol projection", () => {
  it("projects completed text and structured results as artifacts", () => {
    expect(
      invocationToTask({
        createdAt: "2026-09-05T00:00:00.000Z",
        invocationId: "text-task",
        result: "done",
        status: "completed",
      }),
    ).toMatchObject({
      artifacts: [{ parts: [{ text: "done" }] }],
      contextId: "text-task",
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(
      invocationToTask({
        createdAt: "2026-09-05T00:00:00.000Z",
        invocationId: "data-task",
        result: { answer: 42 },
        status: "completed",
      }),
    ).toMatchObject({ artifacts: [{ parts: [{ data: { answer: 42 } }] }] });
  });

  it("projects input and authorization interruptions without credentials", () => {
    const input = invocationToTask({
      createdAt: "2026-09-05T00:00:00.000Z",
      inputRequests: {
        request: {
          action: { callId: "call", input: {}, kind: "tool-call", toolName: "ask_question" },
          kind: "question",
          prompt: "Which region?",
          requestId: "request",
        },
      },
      invocationId: "input-task",
      status: "input_required",
    });
    expect(input).toMatchObject({
      status: {
        message: {
          parts: [{ text: "Which region?" }, { data: { requests: [{ requestId: "request" }] } }],
        },
        state: "TASK_STATE_INPUT_REQUIRED",
      },
    });

    const authorization = invocationToTask({
      authorizations: [
        {
          authorization: {
            instructions: "Open the sign-in page.",
            url: "https://auth.example/authorize",
          },
          description: "Sign in",
          name: "calendar",
        },
      ],
      createdAt: "2026-09-05T00:00:00.000Z",
      invocationId: "auth-task",
      pollAfterMs: 1_000,
      status: "authorization_required",
    });
    expect(authorization).toMatchObject({
      status: {
        message: {
          parts: [
            { text: "Open the sign-in page." },
            { data: { authorizations: [{ name: "calendar" }] } },
          ],
        },
        state: "TASK_STATE_AUTH_REQUIRED",
      },
    });
    expect(JSON.stringify(authorization)).not.toContain("token");
  });

  it.each([{ text: 123 }, { url: 123 }, { raw: 123 }, { data: undefined }])(
    "rejects malformed part content as invalid parameters: %j",
    (part) => {
      expect(() =>
        parseClientMessage({
          messageId: "message",
          parts: [part],
          role: "ROLE_USER",
        }),
      ).toThrow(expect.objectContaining({ code: -32602, message: "Invalid parameters" }));
    },
  );

  it("normalizes text, data, and URL parts without fetching URLs", () => {
    const message = parseClientMessage({
      messageId: "message",
      parts: [
        { text: "Research this" },
        { data: { depth: "deep" } },
        { url: "https://example.com/source" },
      ],
      role: "ROLE_USER",
    });
    expect(messageText(message)).toBe(
      'Research this\n\n```json\n{"depth":"deep"}\n```\nhttps://example.com/source',
    );
  });
});
