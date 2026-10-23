import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { describeHistoryForCompaction } from "#harness/compaction/step.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens, MAX_TEXT_SCALE } from "#harness/token-estimate.js";

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

  it("leaves the gap the capped memory charge does not explain with the ordinary messages", () => {
    const records = [text("note ".repeat(2_000))];
    const request = text("plain request text ".repeat(2_100));

    const described = describeHistoryForCompaction({
      compaction: {
        lastKnownInputTokens: 185_000,
        lastKnownPromptMessageCount: 2,
        recentWindowSize: 1,
        threshold: 180_000,
      },
      memory: records,
      ordinary: [request],
      previousEnvelopeTokens: 0,
      projectedPrompt: [{ ...records[0]! }, request] as HarnessModelMessage[],
      promptSource: [...records, request],
      requestEnvelopeTokens: 0,
    });

    const memoryCharge = estimateTokens(records) * MAX_TEXT_SCALE;
    expect(described.lastKnownInputTokens).toBeCloseTo(185_000 - memoryCharge, 0);
    expect(described.threshold).toBeCloseTo(180_000 - memoryCharge, 0);
  });
});
