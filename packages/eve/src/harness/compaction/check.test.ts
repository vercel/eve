import { describe, expect, it } from "vitest";

import { COMPACTION_CHECKPOINT_MARKER } from "#shared/compaction-checkpoint.js";
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
const automatic = { limit: 10_000 };
const manual = { limit: Number.POSITIVE_INFINITY };

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

  it("lets an automatic result carry the turn's input in its summary", () => {
    const compacted = checkpoint("Bob asked which sources back the second claim.");
    expect(checkHistory(history, compacted, automatic)).toEqual(compacted);
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
    expect(() => checkHistory(before, [latest, result], manual)).toThrow("no earlier message made");
  });

  it("rejects a result placed before its call, and a second result for one call", () => {
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
    expect(() => checkHistory(before, [latest, result, call], manual)).toThrow(
      "no earlier message made",
    );
    expect(() => checkHistory(before, [latest, call, result, result], manual)).toThrow(
      "a second time",
    );
  });

  it("rejects dropping either half of a provider-executed exchange", () => {
    const call: HarnessModelMessage = {
      content: [
        {
          input: {},
          providerExecuted: true,
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      role: "assistant",
    };
    const result: HarnessModelMessage = {
      content: [
        {
          output: { type: "text", value: "Two cases." },
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "assistant",
    };
    const before = [...history, call, result];
    expect(() => checkHistory(before, [latest, call], manual)).toThrow("not its result");
    expect(() => checkHistory(before, [latest, result], manual)).toThrow("no earlier message made");
    expect(checkHistory(before, [latest, call, result], manual)).toHaveLength(3);
    expect(checkHistory(before, [latest], manual)).toHaveLength(1);
  });

  it("keeps a call that was still pending in the input", () => {
    const pending: HarnessModelMessage = {
      content: [{ input: {}, toolCallId: "call-9", toolName: "search", type: "tool-call" }],
      role: "assistant",
    };
    expect(checkHistory([...history, pending], [latest, pending], manual)).toHaveLength(2);
  });

  it("rejects an automatic result over the limit", () => {
    expect(() => checkHistory(history, [latest], { limit: 1 })).toThrow("the limit is ~1");
  });
});
