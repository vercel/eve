import { describe, expect, it, vi } from "vitest";

import type { CompactionContext } from "#shared/compaction-strategy.js";
import type { StoredHistoryMessage } from "#shared/history-message.js";

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
const defaults = vi.hoisted(() => ({
  decide: vi.fn<(history: StoredHistoryMessage[]) => StoredHistoryMessage[] | undefined>(),
  options: vi.fn(),
}));

vi.mock("#internal/logging.js", () => ({
  createLogger: () => logger,
  logError: vi.fn(),
}));
vi.mock("./default.js", () => ({
  defaultCompaction: (options: unknown) => {
    defaults.options(options);
    return async (history: StoredHistoryMessage[]) => defaults.decide(history);
  },
}));

const { openaiCompaction } = await import("./openai.js");

const history: StoredHistoryMessage[] = [
  { content: "Review it.", kind: "user", role: "user" },
  { content: [{ text: "Noted.", type: "text" }], role: "assistant" },
];
const ctx = {
  abortSignal: new AbortController().signal,
  call: vi.fn(),
  estimate: () => 0,
  estimateRatio: 1,
  fixedTokens: 0,
  model: {
    contextWindowTokens: 1_000,
    modelId: "claude-sonnet-4-5",
    provider: "anthropic.messages",
  },
  overflow: false,
  recompacting: false,
  requested: false,
  session: { id: "session" },
  tokens: 700,
} satisfies CompactionContext;

describe("openaiCompaction() default fallback", () => {
  it("passes its threshold to defaultCompaction()", () => {
    defaults.options.mockClear();

    openaiCompaction({ threshold: 0.6 });

    expect(defaults.options).toHaveBeenCalledWith({ threshold: 0.6 });
  });

  it("passes 0.9 to defaultCompaction() when it has no threshold", () => {
    defaults.options.mockClear();

    openaiCompaction();

    expect(defaults.options).toHaveBeenCalledWith({ threshold: 0.9 });
  });

  it("warns about a non-OpenAI model only when the fallback compacts", async () => {
    logger.warn.mockClear();
    const strategy = openaiCompaction();

    defaults.decide.mockReturnValueOnce(undefined);
    expect(await strategy(history, ctx)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();

    defaults.decide.mockReturnValueOnce([history[1]!]);
    expect(await strategy(history, ctx)).toEqual([history[1]]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
