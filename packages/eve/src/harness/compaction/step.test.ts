import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { describeHistoryForCompaction } from "#harness/compaction/step.js";
import type { HarnessModelMessage } from "#harness/messages.js";

const text = (content: string): ModelMessage => ({ content, role: "user" });

describe("describeHistoryForCompaction", () => {
  it("counts the ordinary messages the provider measured, not the memory records in its prompt", () => {
    const measured = text("measured request");
    const appended = text("appended after the count");
    const records = [text("note 1"), text("note 2"), text("note 3")];
    const strippedRecords = records.map((record) => ({ ...record }));

    const described = describeHistoryForCompaction({
      compaction: {
        lastKnownInputTokens: 5_000,
        lastKnownPromptMessageCount: 4,
        recentWindowSize: 1,
        threshold: 20_000,
      },
      memory: records,
      ordinary: [measured, appended],
      previousEnvelopeTokens: 0,
      projectedPrompt: [...strippedRecords, measured] as HarnessModelMessage[],
      promptSource: [...records, measured, appended],
      requestEnvelopeTokens: 0,
    });

    expect(described.lastKnownPromptMessageCount).toBe(1);
  });
});
