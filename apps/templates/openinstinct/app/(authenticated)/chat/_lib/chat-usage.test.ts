import type { SessionStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import {
  chatUsageSnapshot,
  combineChatUsage,
  summarizeChatUsage,
} from "./chat-usage";

describe("chat usage", () => {
  it("keeps a saved total instead of replacing it with a larger but incomplete window", () => {
    const saved = { costUsd: 0.23, inputTokens: 300000, outputTokens: 1000 };
    const window = { costUsd: 0.15, inputTokens: 400000, outputTokens: 1000 };
    expect(chatUsageSnapshot(window, saved, false)).toEqual({
      usage: saved,
      label: "Saved usage",
    });
    expect(chatUsageSnapshot(window, saved, true)).toEqual({
      usage: window,
      label: "Usage",
    });
    expect(chatUsageSnapshot(window, undefined, false)).toEqual({
      usage: window,
      label: "Loaded usage",
    });
  });

  it("sums token and complete cost usage across usage records", () => {
    expect(
      summarizeChatUsage([
        usageRecorded("run-1", 1200, 300, 0.012),
        usageRecorded("run-2", 800, 200, 0.008),
      ])
    ).toEqual({ costUsd: 0.02, inputTokens: 2000, outputTokens: 500 });
  });

  it("does not present a partial model cost as the chat total", () => {
    expect(
      summarizeChatUsage([
        usageRecorded("run-1", 1200, 300, 0.012),
        usageRecorded("run-2", 800, 200),
      ])
    ).toEqual({ costUsd: null, inputTokens: 2000, outputTokens: 500 });
  });

  it("combines persisted chat summaries for the global view", () => {
    expect(
      combineChatUsage([
        { costUsd: 0.012, inputTokens: 1200, outputTokens: 300 },
        { costUsd: 0.008, inputTokens: 800, outputTokens: 200 },
      ])
    ).toEqual({ costUsd: 0.02, inputTokens: 2000, outputTokens: 500 });
  });

  it("does not present a partial cost as the global total", () => {
    expect(
      combineChatUsage([
        { costUsd: 0.012, inputTokens: 1200, outputTokens: 300 },
        { costUsd: null, inputTokens: 800, outputTokens: 200 },
      ])
    ).toEqual({ costUsd: null, inputTokens: 2000, outputTokens: 500 });
  });
});

function usageRecorded(
  runId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd?: number
): SessionStreamEvent {
  return {
    data: {
      kind: "model",
      owner: { runId },
      usage: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
        inputTokens,
        outputTokens,
      },
    },
    meta: {
      at: "2026-08-26T00:00:00.000Z",
      endOfLine: true,
      position: { index: 0, line: 0 },
    },
    scope: { runId, turnId: "turn-1" },
    type: "usage.recorded",
  };
}
