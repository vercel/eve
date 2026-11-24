import { describe, expect, it, vi } from "vitest";

import { strategyHistory, type StrategyRun } from "#harness/compaction/strategy.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { CompactionContext, CompactionStrategy } from "#shared/compaction-strategy.js";

const history: HarnessModelMessage[] = [{ content: "hello", kind: "user", role: "user" }];

function run(overrides: Partial<StrategyRun> = {}): StrategyRun {
  return {
    abortSignal: new AbortController().signal,
    call: () => Promise.reject(new Error("unused")),
    estimateRatio: 1.3,
    fixedTokens: 500,
    identity: () => Promise.resolve({ modelId: "gpt-5", provider: "openai.responses" }),
    model: { contextWindowTokens: 200_000, maxOutputTokens: 8_000 },
    overflow: false,
    recompacting: false,
    requested: false,
    sessionId: "s",
    ...overrides,
  };
}

async function contextOf(strategyRun: StrategyRun, tokens = 1_234): Promise<CompactionContext> {
  let seen: CompactionContext | undefined;
  const strategy: CompactionStrategy = (_history, ctx) => {
    seen = ctx;
    return undefined;
  };
  await strategyHistory(strategy, strategyRun)({ history, tokens });
  return seen!;
}

describe("strategyHistory", () => {
  it("builds the context from the run, the measured tokens and the model's identity", async () => {
    const ctx = await contextOf(run({ recompacting: true }));

    expect(ctx).toMatchObject({
      estimateRatio: 1.3,
      fixedTokens: 500,
      model: {
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_000,
        modelId: "gpt-5",
        provider: "openai.responses",
      },
      overflow: false,
      recompacting: true,
      requested: false,
      session: { id: "s" },
      tokens: 1_234,
    });
    expect(ctx.estimate(history)).toBe(estimateTokens(history));
  });

  it("passes the history to the strategy and returns what it keeps", async () => {
    const kept: HarnessModelMessage[] = [{ content: "kept", kind: "user", role: "user" }];
    const strategy = vi.fn((_history: readonly HarnessModelMessage[]) => kept);

    const result = await strategyHistory(strategy, run())({ history, tokens: 10 });

    expect(strategy.mock.calls[0]![0]).toEqual(history);
    expect(strategy.mock.calls[0]![0]).not.toBe(history);
    expect(result).toBe(kept);
  });

  it("returns undefined when the strategy keeps the history", async () => {
    expect(await strategyHistory(() => undefined, run())({ history, tokens: 10 })).toBeUndefined();
  });

  it.each([
    ["a requested compaction", { requested: true }],
    ["an overflow retry", { overflow: true }],
  ])("marks %s on the context", async (_name, flags) => {
    const ctx = await contextOf(run(flags));

    expect({ overflow: ctx.overflow, requested: ctx.requested }).toEqual({
      overflow: false,
      requested: false,
      ...flags,
    });
  });

  it("rejects a compaction that is requested and an overflow retry at once", async () => {
    const strategy = vi.fn();

    await expect(
      strategyHistory(strategy, run({ overflow: true, requested: true }))({ history, tokens: 10 }),
    ).rejects.toThrow("either requested or an overflow retry, never both");
    expect(strategy).not.toHaveBeenCalled();
  });

  it("hands the strategy a copy, so editing it in place leaves the history untouched", async () => {
    const original: HarnessModelMessage[] = [
      { content: [{ text: "hello", type: "text" }], kind: "user", role: "user" },
    ];
    const strategy: CompactionStrategy = (messages) => {
      const first = messages[0];
      if (Array.isArray(first?.content)) (first.content[0] as { text: string }).text = "edited";
      return undefined;
    };

    await strategyHistory(strategy, run())({ history: original, tokens: 1 });

    expect(original[0]?.content).toEqual([{ text: "hello", type: "text" }]);
  });

  it("copies file parts whose data is a URL or bytes", async () => {
    const url = new URL("https://example.com/report.pdf");
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from([4, 5, 6]);
    const original: HarnessModelMessage[] = [
      {
        content: [
          { data: url, mediaType: "application/pdf", type: "file" },
          { data: bytes, mediaType: "image/png", type: "file" },
          { data: buffer, mediaType: "image/gif", type: "file" },
        ],
        kind: "user",
        role: "user",
      },
    ];
    let seen: readonly HarnessModelMessage[] = [];
    const strategy: CompactionStrategy = (messages) => {
      seen = messages as readonly HarnessModelMessage[];
      return undefined;
    };

    await strategyHistory(strategy, run())({ history: original, tokens: 1 });

    expect(seen).toEqual(original);
    const parts = (seen[0]?.content ?? []) as { data: unknown }[];
    expect(parts[0]?.data).toBeInstanceOf(URL);
    expect(parts[0]?.data).not.toBe(url);
    expect(parts[1]?.data).toBeInstanceOf(Uint8Array);
    expect(parts[1]?.data).not.toBe(bytes);
    expect(Buffer.isBuffer(parts[2]?.data)).toBe(true);
    expect(parts[2]?.data).not.toBe(buffer);
  });
});
