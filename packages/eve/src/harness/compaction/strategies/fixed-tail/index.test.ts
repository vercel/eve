import { describe, expect, it } from "vitest";

import type { CompactionContext } from "#harness/compaction/strategy.js";
import { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";

const chunk = "x".repeat(4_000);

function history(): HarnessModelMessage[] {
  return Array.from({ length: 8 }, (_, index) =>
    index % 2 === 0
      ? ({ content: `${index} ${chunk}`, kind: "user", role: "user" } as const)
      : ({ content: `${index} ${chunk}`, role: "assistant" } as const),
  ) as HarnessModelMessage[];
}

function contextOf(threshold: number): CompactionContext {
  return {
    estimateTokens,
    forced: false,
    inputTokens: threshold + 1_000,
    recentWindowSize: 20,
    requestEnvelopeTokens: 0,
    summarize: async () => "summary",
    threshold,
  };
}

async function keptVerbatim(options: Parameters<typeof fixedTail>[0], threshold: number) {
  const result = await fixedTail(options).compact(history(), contextOf(threshold));
  return result.filter((message) => JSON.stringify(message.content).includes("xxxx")).length;
}

describe("fixedTail options", () => {
  it("keeps up to recentTokens of the latest conversation, 20,000 by default", async () => {
    const byDefault = await keptVerbatim({}, 100_000);
    const small = await keptVerbatim({ recentTokens: 1_100 }, 100_000);
    const none = await keptVerbatim({ recentTokens: 1 }, 100_000);
    expect(small).toBeGreaterThan(none);
    expect(byDefault).toBeGreaterThan(small);
  });

  it.each([{ recentTokens: 0 }, { recentTokens: 1.5 }])("rejects %o", (options) => {
    expect(() => fixedTail(options)).toThrow(/must be a positive integer/);
  });
});
