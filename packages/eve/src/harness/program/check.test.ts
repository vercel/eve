import { describe, expect, it } from "vitest";

import { COMPACTION_CHECKPOINT_MARKER } from "#harness/compaction/prompt.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  type HarnessModelMessage,
} from "#harness/messages.js";
import { checkHistory } from "./check.js";

const earlier = createUserMessage("user", "Alice asks for the quarterly report.");
const latest = createUserMessage("user", "Bob asks which sources back the second claim.");
const history: HarnessModelMessage[] = [
  earlier,
  { content: "Here is the report.", role: "assistant" },
  latest,
];
const automatic = { automatic: true, limit: 10_000 };
const manual = { automatic: false, limit: 10_000 };

function checkpoint(summary: string): HarnessModelMessage[] {
  return [
    createFrameworkUserMessage("context.compaction", COMPACTION_CHECKPOINT_MARKER),
    { content: summary, role: "assistant" },
  ];
}

describe("checkHistory", () => {
  it("accepts a checkpoint followed by the turn's input", () => {
    const compacted = [...checkpoint("Alice got her report."), latest];
    expect(checkHistory(history, compacted, automatic)).toEqual(compacted);
  });

  it("rejects an automatic result that keeps an earlier message but not the latest input", () => {
    expect(() =>
      checkHistory(history, [...checkpoint("Bob had a question."), earlier], automatic),
    ).toThrow("drops the turn's input");
  });

  it("lets a manual result drop the latest input, since no model call answers it next", () => {
    expect(checkHistory(history, checkpoint("Alice and Bob talked."), manual)).toHaveLength(2);
  });

  it("rejects a checkpoint after other messages", () => {
    expect(() =>
      checkHistory(history, [latest, ...checkpoint("Alice got her report.")], manual),
    ).toThrow("checkpoint after other messages");
  });

  it("rejects a call kept without its result, and a result kept without its call", () => {
    const call: HarnessModelMessage = {
      content: [{ input: {}, toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      role: "assistant",
    };
    const result: HarnessModelMessage = {
      content: [
        {
          output: { type: "text", value: "Two cases." },
          toolCallId: "call-1",
          toolName: "search",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const before = [...history, call, result];
    expect(() => checkHistory(before, [latest, call], manual)).toThrow("not its result");
    expect(() => checkHistory(before, [latest, result], manual)).toThrow("not the call");
  });

  it("rejects an automatic result over the limit", () => {
    expect(() => checkHistory(history, [latest], { automatic: true, limit: 1 })).toThrow(
      "the limit is ~1",
    );
  });
});
