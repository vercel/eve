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
import {
  convertLegacyEvents,
  createV26HistoryReader,
  v26LineStream,
} from "#execution/v26-history.js";
import { cascade } from "#harness/session-machine/cascade.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { createEventReader } from "#protocol/session-lines.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
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

  it("reads the end a v27 deployment appends to a stranded v26 session as it was written", () => {
    // What a v27 deployment writes when Alice resets the session Bob left waiting on an approval.
    const recorded = emptySessionView();
    for (const event of read(PENDING_APPROVAL).events) foldReceivedEvent(recorded, event);
    const ended: SessionEvent = {
      data: {
        cause: { policy: "stranded-message" },
        error: { code: "session_stranded", message: "This session is no longer available." },
        outcome: "failed",
      },
      type: "session.ended",
    };
    const end = { at: "2026-10-01T00:00:00.000Z", facts: cascade(recorded, [ended]) };

    const { events, violations } = read([...PENDING_APPROVAL, end]);
    expect(violations).toEqual([]);
    const tables = sessionTables(conversationOf(events).view);
    expect(tables.session.status).toBe("ended");
    expect(Object.values(tables.interactions).map((row) => row.status)).toEqual(["settled"]);
  });

  it("reads nothing from a record that isn't a line", () => {
    expect(createV26HistoryReader().read("not a record", 0)).toBeUndefined();
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

describe("convertLegacyEvents", () => {
  it("reads saved events as the session's stream serves them, at their stored positions", async () => {
    const reader = createEventReader();
    const served: SessionStreamEvent[] = [];
    let position = 0;
    for await (const value of v26LineStream(streamOf(KITCHEN_SINK), 0)) {
      if (isStoredLine(value)) served.push(...reader.read(value, position));
      position += 1;
    }
    expect(convertLegacyEvents(KITCHEN_SINK)).toEqual(served);
  });

  it("leaves events saved mid-turn unfinished, at the positions they were stored", () => {
    // Saved while the second turn streamed its reply: the last event is a delta.
    const delta = {
      data: { messageDelta: "It is", sequence: 1, stepIndex: 0, turnId: "turn_1" },
      meta: { at: "2026-10-01T00:00:00.000Z" },
      type: "message.appended",
    };
    const saved = [...KITCHEN_SINK.slice(0, 13), delta];
    const events = convertLegacyEvents(saved);
    const lines = events.map((event) => event.meta.position.line);
    // Each event keeps its stored line; the trailing delta reads as none, so the last is earlier.
    expect(lines).toEqual(lines.toSorted((a, b) => a - b));
    expect(lines.at(-1)).toBe(12);
    const tables = sessionTables(conversationOf(events).view);
    expect(tables.turns["turn_1"]?.status).toBe("running");
    expect(tables.session.status).not.toBe("ended");
  });

  it("refuses events it can't read in order from the session's first", () => {
    expect(() => convertLegacyEvents([])).toThrow(/from its first/);
    expect(() => convertLegacyEvents(KITCHEN_SINK.slice(1))).toThrow(/from its first/);
    expect(() => convertLegacyEvents([...PENDING_APPROVAL, ...ATTACHMENT])).toThrow(
      `Saved event ${String(PENDING_APPROVAL.length)} starts another session.`,
    );
    const converted = convertLegacyEvents(PENDING_APPROVAL);
    expect(() => convertLegacyEvents([PENDING_APPROVAL[0], converted[1]])).toThrow(
      /Saved event 1 isn't an event saved before the upgrade/,
    );
  });
});

function streamOf(records: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const record of records) controller.enqueue(record);
      controller.close();
    },
  });
}
