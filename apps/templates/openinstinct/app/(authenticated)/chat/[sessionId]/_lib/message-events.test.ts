import type { SessionEvent, SessionStreamEvent } from "eve/client";
import {
  type CallOutcome,
  emptySessionView,
  foldEvents,
  type JsonValue,
} from "eve/events";
import { describe, expect, it } from "vitest";
import {
  imessageTimestamps,
  messageTimestamps,
  sentMessages,
} from "./message-events";

describe("iMessage event projection", () => {
  it("displays the contact introduction and download attachment in browser chat", () => {
    const events = [
      ...toolResult("share_contact", {
        kind: "message",
        text: "Save my contact.",
        attachments: [
          {
            kind: "file",
            mimeType: "text/vcard",
            name: "OpenInstinct.vcf",
            url: "https://example.com/contacts/openinstinct.vcf?signed=true",
          },
        ],
      }),
    ];
    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      expect.objectContaining({
        parts: [
          expect.objectContaining({ type: "text", text: "Save my contact." }),
          expect.objectContaining({
            type: "file",
            filename: "OpenInstinct.vcf",
            mediaType: "text/vcard",
            url: "https://example.com/contacts/openinstinct.vcf?signed=true",
          }),
        ],
      }),
    ]);
    expect(sentMessages(viewOf(toolResult("share_contact", null))).size).toBe(
      0
    );
  });
  it("projects only successful send_message results", () => {
    const events = [
      ...completedMessage(
        "Internal terminal output",
        "2026-09-01T12:00:00.000Z"
      ),
      ...toolResult("web_search", { answer: "Internal search result" }),
      ...toolResult(
        "send_message",
        {
          attachments: [
            {
              kind: "image",
              name: "result.png",
              url: "https://example.com/result.png",
            },
          ],
          kind: "message",
          text: "Here is the user-visible result.",
        },
        "2026-09-01T12:00:02.000Z"
      ),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      {
        id: "turn-1:assistant:call-send_message",
        parts: [
          {
            state: "done",
            text: "Here is the user-visible result.",
            type: "text",
          },
          {
            filename: "result.png",
            mediaType: "image/*",
            type: "file",
            url: "https://example.com/result.png",
          },
        ],
        timestamp: "2026-09-01T12:00:02.000Z",
      },
    ]);
    expect(messageTimestamps(events).get("turn-1:assistant")).toBe(
      "2026-09-01T12:00:00.000Z"
    );
    expect(imessageTimestamps(events).has("turn-1:assistant")).toBe(false);
  });

  it("projects a compact reaction for the Eve chat", () => {
    const events = [
      ...toolResult("react_to_message", { operation: "add", type: "heart" }),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      expect.objectContaining({
        id: "turn-1:assistant:call-react_to_message",
        parts: [expect.objectContaining({ text: "❤️" })],
      }),
    ]);
    expect(imessageTimestamps(events).has("turn-1:assistant")).toBe(false);
  });

  it("does not project a removed reaction as a new message", () => {
    const events = [
      ...toolResult("react_to_message", { operation: "remove", type: "heart" }),
    ];

    expect(sentMessages(viewOf(events)).has("turn-1:assistant")).toBe(false);
  });

  it("projects a native link-preview send as its URL", () => {
    const events = [
      ...toolResult(
        "send_message",
        { kind: "link", url: "https://example.com/article" },
        "2026-09-01T12:00:01.000Z"
      ),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      {
        id: "turn-1:assistant:call-send_message",
        parts: [
          {
            state: "done",
            text: "https://example.com/article",
            type: "text",
          },
        ],
        timestamp: "2026-09-01T12:00:01.000Z",
      },
    ]);
  });

  it("keeps plain-text line breaks visible in the chat view", () => {
    const events = [
      ...toolResult(
        "send_message",
        { kind: "message", text: "line one\nline two" },
        "2026-09-01T12:00:01.000Z",
        "completed",
        "call-lines"
      ),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      expect.objectContaining({
        parts: [expect.objectContaining({ text: "line one  \nline two" })],
      }),
    ]);
  });

  it("treats reply association as transport metadata in the Eve chat", () => {
    const events = [
      ...toolResult("send_message", {
        kind: "message",
        replyTo: { kind: "current" },
        text: "This is still a normal Eve message.",
      }),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            text: "This is still a normal Eve message.",
          }),
        ],
      }),
    ]);
  });

  it("keeps consecutive sends in the same turn as separate messages", () => {
    const events = [
      ...toolResult(
        "send_message",
        { kind: "message", text: "The useful result." },
        "2026-09-01T12:00:01.000Z",
        "completed",
        "call-result"
      ),
      ...toolResult(
        "send_message",
        { kind: "message", text: "Want me to book it?" },
        "2026-09-01T12:00:02.000Z",
        "completed",
        "call-question"
      ),
    ];

    expect(sentMessages(viewOf(events)).get("turn-1:assistant")).toEqual([
      expect.objectContaining({
        id: "turn-1:assistant:call-result",
        parts: [expect.objectContaining({ text: "The useful result." })],
      }),
      expect.objectContaining({
        id: "turn-1:assistant:call-question",
        parts: [expect.objectContaining({ text: "Want me to book it?" })],
      }),
    ]);
  });

  it.each(["failed", "rejected"] as const satisfies readonly CallOutcome[])(
    "ignores %s send_message results",
    (status) => {
      const events = [
        ...toolResult(
          "send_message",
          { kind: "message", text: "This was not delivered." },
          "2026-09-01T12:00:01.000Z",
          status
        ),
      ];

      expect(sentMessages(viewOf(events)).has("turn-1:assistant")).toBe(false);
      expect(imessageTimestamps(events).has("turn-1:assistant")).toBe(false);
    }
  );
});

function toolResult(
  toolName: string,
  output: JsonValue,
  at = "2026-09-01T12:00:01.000Z",
  outcome: CallOutcome = "completed",
  callId = `call-${toolName}`
): SessionStreamEvent[] {
  const scope = { runId: `run-${callId}`, turnId: "turn-1" };
  return [
    streamed(
      {
        data: { owner: { turnId: "turn-1" }, runId: scope.runId },
        scope,
        type: "model.requested",
      },
      at
    ),
    streamed(
      {
        data: {
          callId,
          capability: { kind: "tool", name: toolName },
          input: {},
          owner: { runId: scope.runId },
        },
        scope,
        type: "call.requested",
      },
      at
    ),
    streamed(
      {
        data:
          outcome === "completed"
            ? { callId, outcome, output }
            : {
                callId,
                error: { code: "tool_failed", message: "Not delivered." },
                outcome,
              },
        scope,
        type: "call.settled",
      },
      at
    ),
  ];
}

function completedMessage(value: string, at: string): SessionStreamEvent[] {
  return [
    streamed(
      {
        data: {
          kind: "text",
          partId: "part-reply",
          phase: "reply",
          runId: "run-reply",
          value,
        },
        scope: { runId: "run-reply", turnId: "turn-1" },
        type: "content.completed",
      },
      at
    ),
  ];
}

let nextLine = 0;

function streamed(fact: SessionEvent, at: string): SessionStreamEvent {
  const line = nextLine;
  nextLine += 1;
  return {
    ...fact,
    meta: { at, endOfLine: true, position: { index: 0, line } },
  };
}

function viewOf(events: readonly SessionStreamEvent[]) {
  return foldEvents(emptySessionView(), events);
}
