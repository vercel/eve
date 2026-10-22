import { describe, expect, it } from "vitest";

import { conversationOf } from "#client/conversation.js";
import type { EveMessage } from "#client/message-types.js";
import { transcriptOf } from "#client/transcript.js";
import {
  ATTACHMENT,
  KITCHEN_SINK,
  PENDING_APPROVAL,
  STEER_AND_CANCEL,
} from "#execution/v26-history.fixtures.js";
import { createV26HistoryReader, v26LineStream } from "#execution/v26-history.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { createEventReader } from "#protocol/session-lines.js";
import { idle, waiting } from "#protocol/session-projection/selectors.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";

/** What a v27 reader reads from stored v26 records, with the checker's verdict on every line. */
function read(records: readonly unknown[]) {
  const history = createV26HistoryReader();
  const checker = createStreamChecker();
  const events = createEventReader();
  const read: SessionStreamEvent[] = [];
  const violations: unknown[] = [];
  records.forEach((record, position) => {
    const line = history.read(record, position);
    if (line === undefined) return;
    violations.push(...checker.check(line, position));
    read.push(...events.read(line, position));
  });
  return { events: read, violations };
}

/** A message as a person sees it: who wrote it, the text, and each call with its outcome. */
function shown(message: EveMessage): string {
  const parts = message.parts.flatMap((part) => {
    switch (part.type) {
      case "text":
        return [part.text];
      case "tool": {
        const outcome = part.interaction?.outcome;
        const asked = outcome === undefined ? "" : ` (${outcome})`;
        return [`[${part.name} ${part.state}${asked}]`];
      }
      case "file":
        return [`<${String((part as { readonly filename?: string }).filename)}>`];
      default:
        return [];
    }
  });
  return `${message.role}: ${parts.join(" | ")}`;
}

describe("createV26HistoryReader", () => {
  // The expected messages are what v27 shows for the same conversation recorded by v27.
  it("reads a v26 conversation as v27 records it, without breaking a lifecycle rule", () => {
    const { events, violations } = read(KITCHEN_SINK);
    expect(violations).toEqual([]);
    const state = conversationOf(events);
    expect(state.messages.map(shown)).toEqual([
      "user: hello there",
      "assistant: Echo: hello there",
      "user: what is the weather",
      'assistant: Let me check the weather. | [get_weather completed] | get_weather said: {"city":"Paris","forecast":"sunny","temperatureC":21}',
      "user: please run the gate",
      'assistant: [gate completed (accepted)] | gate said: {"executed":true,"marker":"M1"}',
      "user: run the gate again",
      'assistant: [gate rejected (declined)] | gate said: "Tool execution was denied."',
      "user: ask me a question",
      'assistant: [ask_question completed (accepted)] | ask_question said: {"answer":"Blue","status":"answered"}',
      "user: ask me a question again",
      'assistant: [ask_question completed (accepted)] | ask_question said: {"answer":"Green, actually","status":"answered"}',
      "user: delegate to the helper",
      "assistant: [helper completed] | Started the helper. | The helper said HELPER-MARKER-42.",
      "user: explode please",
      'assistant: [explode failed] | explode said: "Error: Kaboom"',
      "user: do both things",
      "assistant: [get_weather completed] | [gate completed (accepted)] | Both done.",
      "user: hello after clear",
      "assistant: Echo: hello after clear",
      "user: Earlier question from another system",
      "assistant: Earlier answer from another system",
      "user: IMPORT this and say hi",
      "assistant: Echo: IMPORT this and say hi",
      "user: hello after compact",
      "assistant: Echo: hello after compact",
    ]);
    expect(idle(sessionTables(state.view))).toBe(true);
    // A transcript starts over at the clear, as v27's does.
    expect(transcriptOf(events).messages.map(({ text }) => text)).toEqual([
      "hello after clear",
      "Echo: hello after clear",
      "Earlier question from another system",
      "Earlier answer from another system",
      "IMPORT this and say hi",
      "Echo: IMPORT this and say hi",
      "hello after compact",
      "Echo: hello after compact",
    ]);
  });

  it("closes what a cancel cut, and keeps a steering message apart from the reply", () => {
    const { events, violations } = read(STEER_AND_CANCEL);
    expect(violations).toEqual([]);
    const state = conversationOf(events);
    expect(state.messages.map(shown)).toEqual([
      "user: slow please",
      "assistant: [slow completed]",
      "user: actually, also this steering note",
      "assistant: Echo: actually, also this steering note",
      "user: slow please again",
      "assistant: [slow cancelled]",
    ]);
    expect(sessionTables(state.view).turns["turn_1"]).toMatchObject({ outcome: "cancelled" });
    expect(idle(sessionTables(state.view))).toBe(true);
  });

  it("leaves a turn that ended its recording on an approval waiting on that person", () => {
    const { events, violations } = read(PENDING_APPROVAL);
    expect(violations).toEqual([]);
    const state = conversationOf(events);
    expect(state.messages.map(shown)).toEqual([
      "user: please run the gate",
      "assistant: [gate approval]",
    ]);
    expect(waiting(sessionTables(state.view), "turn_0")?.on).toBe("interaction");
  });

  it("reads attachments v26 kept no bytes for as unavailable files", () => {
    const { events, violations } = read(ATTACHMENT);
    expect(violations).toEqual([]);
    expect(conversationOf(events).messages.map(shown)[0]).toBe("user: here is a file | <note.txt>");
  });

  it("starts a transcript over at a reset that ended a stranded session", () => {
    const at = "2026-10-01T00:00:00.000Z";
    const turn = { sequence: 0, turnId: "turn_0" };
    const failed = (trigger: string) => ({
      data: { code: "session_stranded", details: { trigger }, message: "ended", sessionId: "s" },
      meta: { at },
      type: "session.failed",
    });
    const received = {
      data: { ...turn, message: "Bob asks." },
      meta: { at },
      type: "message.received",
    };
    expect(transcriptOf(read([received, failed("reset")]).events).messages).toEqual([]);
    expect(transcriptOf(read([received, failed("message")]).events).messages).toHaveLength(1);
  });

  it("reads nothing from a v27 line or a record that isn't a v26 event", () => {
    const history = createV26HistoryReader();
    expect(history.read({ at: "2026-10-01T00:00:00.000Z", facts: [] }, 0)).toBeUndefined();
    expect(history.read("not a record", 1)).toBeUndefined();
  });
});

describe("v26LineStream", () => {
  it("reads every record from the first, and marks the records that read as no line", async () => {
    const records = new ReadableStream<unknown>({
      start(controller) {
        for (const record of KITCHEN_SINK) controller.enqueue(record);
        controller.close();
      },
    });
    const out: unknown[] = [];
    for await (const value of v26LineStream(records, 5)) out.push(value);
    // One output per stored record from the cursor on, so positions keep counting stored lines.
    expect(out).toHaveLength(KITCHEN_SINK.length - 5);
    // The first session.waiting reads as no line: the turn before it already settled.
    expect(out[8 - 5]).toEqual({ $eve: "position", next: 9 });
  });
});
