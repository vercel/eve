import { describe, expect, it } from "vitest";

import {
  anchorToTurn,
  createFrameworkUserMessage,
  type HarnessModelMessage,
  type UserModelMessage,
} from "#harness/messages.js";
import { keptAnnouncements } from "#harness/announcements.js";
import { announce, placeAnchored } from "./messages.js";
import type { CallRecord } from "./definition.js";

function input(content: string, turnId: string): UserModelMessage {
  return anchorToTurn({ content, kind: "user", role: "user" }, turnId);
}

function said(content: string): HarnessModelMessage {
  return { content, role: "assistant" };
}

const texts = (messages: readonly HarnessModelMessage[]) => messages.map(({ content }) => content);

/** One model call's messages: announcements join the record, recall sits ahead of its turn. */
function call(
  history: readonly HarnessModelMessage[],
  turn: readonly UserModelMessage[],
  recalled: readonly { readonly turnId: string; readonly content: string }[],
  announced?: string,
) {
  const draft: CallRecord = { historyState: {}, record: history };
  const record =
    announced === undefined
      ? draft
      : announce(draft, new Set(turn), { state: { render: () => announced, value: announced } });
  const view = placeAnchored(
    record.record,
    recalled.map(({ content, turnId }) => ({
      message: createFrameworkUserMessage("memory.load", content),
      turnId,
    })),
  );
  return { history: record.record, view };
}

describe("a call's messages", () => {
  it("keeps each turn's recall ahead of its input, so each call extends the one before", () => {
    const first = input("first request", "turn_0");
    const recalledFirst = [{ content: "memory A", turnId: "turn_0" }];
    const opening = call([first], [first], recalledFirst);
    const continuing = call([first, said("working")], [first], recalledFirst);
    const second = input("second request", "turn_1");
    const later = [first, said("working"), said("done"), second];
    const recalled = [...recalledFirst, { content: "memory B", turnId: "turn_1" }];
    const next = call(later, [second], recalled, "skills state");
    const after = call([...next.history, said("on it")], [second], recalled);

    expect(texts(opening.view)).toEqual(["memory A", "first request"]);
    expect(texts(next.view)).toEqual([
      "memory A",
      "first request",
      "working",
      "done",
      "skills state",
      "memory B",
      "second request",
    ]);
    for (const [before, then] of [
      [opening, continuing],
      [continuing, next],
      [next, after],
    ] as const) {
      expect(then.view.slice(0, before.view.length)).toEqual(before.view);
    }
    expect(texts(next.history)).not.toContain("memory B");
  });

  it("puts recall whose turn compaction summarized after the checkpoint", () => {
    const latest = input("latest request", "turn_5");
    const compacted: HarnessModelMessage[] = [
      { content: "checkpoint", kind: "context.compaction", role: "user" },
      said("summary"),
      latest,
    ];

    const { view } = call(
      compacted,
      [latest],
      [
        { content: "memory A", turnId: "turn_0" },
        { content: "memory C", turnId: "turn_5" },
      ],
    );

    expect(texts(view)).toEqual([
      "checkpoint",
      "summary",
      "memory A",
      "memory C",
      "latest request",
    ]);
  });

  it("holds announcements while a provider tool's result is still to come", () => {
    const history: HarnessModelMessage[] = [
      { role: "user", content: "search and date", kind: "user" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "srvtoolu_1",
            toolName: "web_search",
            input: {},
            providerExecuted: true,
          },
          { type: "tool-call", toolCallId: "toolu_1", toolName: "bash", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            toolName: "bash",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ];
    const skills = { skills: { render: () => "skills changed", value: "v2" } };
    const baseline = { announcements: { skills: "v1" } };

    // The request still ends on the local result, and the old baseline stays for the next one.
    const waiting = announce({ historyState: baseline, record: history }, new Set(), skills);
    expect(waiting.record).toEqual(history);
    expect(waiting.historyState).toEqual(baseline);

    const settled = announce(
      { historyState: baseline, record: history.slice(0, 1) },
      new Set(),
      skills,
    );
    expect(settled.record.at(-1)).toMatchObject({ content: "skills changed" });
    expect(settled.historyState).toEqual({
      announcements: { skills: "v2" },
      messages: { skills: expect.any(String) },
    });
  });

  it("announces again after a rewrite only what the rewrite dropped", () => {
    const question = input("Which sources?", "turn_1");
    const announcements = {
      brief: { kind: "context.instruction" as const, render: () => "Release brief.", value: "b" },
      catalog: { render: () => "You have more tools.", value: "c" },
    };
    const first = announce(
      { historyState: {}, record: [question] },
      new Set([question]),
      announcements,
    );
    // A rewrite that keeps the brief's message, as capping tool results does, and drops the catalog's.
    const history = first.record.filter(({ content }) => content !== "You have more tools.");
    const again = announce(
      { historyState: keptAnnouncements(first.historyState, history), record: history },
      new Set(),
      announcements,
    );

    expect(texts(again.record)).toEqual([
      "Release brief.",
      "Which sources?",
      "You have more tools.",
    ]);
  });
});
