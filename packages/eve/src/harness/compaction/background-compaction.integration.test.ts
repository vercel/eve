import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  backgroundCompaction,
  shouldCompactInBackground,
} from "#harness/compaction/examples/background-compaction.js";
import { fixedTail } from "#harness/compaction/strategies/fixed-tail/index.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { readReactionsState, writeReactionsState } from "#reactions/state.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const SYSTEM = "You help Alice.";
const ENVELOPE_TOKENS = 3_000;
const OUTPUT_TOKENS = 500;
const SUMMARY_TOKENS = 600;
const TURNS = 14;
const THRESHOLD = 20_000;

const textStream = (text: string, inputTokens: number, outputTokens: number): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of [
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: text, id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
            outputTokens: { reasoning: 0, text: outputTokens, total: outputTokens },
          },
        },
      ] as StreamPart[])
        controller.enqueue(part);
      controller.close();
    },
  }),
});

const promptTokens = (prompt: unknown): number => Math.ceil(JSON.stringify(prompt).length / 4);

interface TurnRow {
  readonly turn: number;
  readonly inputTokens: number;
  readonly summaryInputTokens: number;
  readonly compactions: number;
}

async function runConversation(
  strategy: CompactionStrategy,
  background: boolean,
): Promise<readonly TurnRow[]> {
  let summaryInput = 0;
  let mainInput = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const tokens = promptTokens(prompt);
      if (!String(prompt[0]?.content).includes(SYSTEM)) {
        summaryInput += tokens;
        return textStream("S".repeat(SUMMARY_TOKENS * 4), tokens, SUMMARY_TOKENS);
      }
      mainInput = tokens + ENVELOPE_TOKENS;
      return textStream("A".repeat(OUTPUT_TOKENS * 4), mainInput, OUTPUT_TOKENS);
    },
  });
  const ctx = new ContextContainer();
  let session: HarnessSession = {
    agent: { modelReference: { id: "turn-model" }, system: SYSTEM, tools: [] },
    compaction: {
      recentWindowSize: 2,
      requestEnvelopeTokens: ENVELOPE_TOKENS,
      threshold: THRESHOLD,
    },
    continuationToken: "http:background",
    history: [],
    sessionId: "background",
  };
  const rows: TurnRow[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const events: SessionEvent[] = [];
    const handle = foldingHandler();
    summaryInput = 0;
    await contextStorage.run(ctx, async () => {
      let stepped = await createToolLoopHarness({
        compactionStrategy: strategy,
        handleEvent: async (publication) => {
          events.push(...eventsOf(publication));
          await handle(publication);
        },
        resolveModel: async () => model,
        tools: new Map(),
      })(session, { message: `Turn ${turn}. ${"detail ".repeat(1_200)}` });
      while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
      session = stepped.session;
    });
    rows.push({
      compactions: events.filter((event) => event.type === "context.started").length,
      inputTokens: mainInput,
      summaryInputTokens: summaryInput,
      turn,
    });
    // What the `turn.settled` hook does: ask for a compaction in the idle gap.
    if (background && shouldCompactInBackground(mainInput)) {
      writeReactionsState(ctx, {
        ...readReactionsState(ctx),
        intents: [{ occurrence: `t${turn}`, reactionId: "hooks/compact.ts", type: "compact" }],
      });
    }
  }
  return rows;
}

const PRICE_PER_MTOK = { input: 3, output: 15 };
const cost = (rows: readonly TurnRow[]): number =>
  rows.reduce(
    (sum, row) =>
      sum +
      ((row.inputTokens + row.summaryInputTokens) * PRICE_PER_MTOK.input +
        (OUTPUT_TOKENS + (row.summaryInputTokens > 0 ? SUMMARY_TOKENS * row.compactions : 0)) *
          PRICE_PER_MTOK.output) /
        1e6,
    0,
  );

describe("background compaction", () => {
  it("keeps every turn's input below the default strategy's, at a summary call per turn", async () => {
    const fixed = await runConversation(fixedTail(), false);
    const background = await runConversation(backgroundCompaction(), true);

    const lines = [
      "turn | fixedTail input | fixedTail compactions | background input | background compactions",
      ...fixed.map(
        (row, index) =>
          `${row.turn} | ${row.inputTokens} | ${row.compactions} | ${background[index]?.inputTokens} | ${background[index]?.compactions}`,
      ),
      `cost USD | ${cost(fixed).toFixed(3)} | | ${cost(background).toFixed(3)} |`,
    ];
    console.info(lines.join("\n"));

    const peak = (rows: readonly TurnRow[]) => Math.max(...rows.map((row) => row.inputTokens));
    expect(fixed.some((row) => row.compactions > 0)).toBe(true);
    expect(peak(background)).toBeLessThan(peak(fixed));
    expect(background.filter((row) => row.compactions > 0).length).toBeGreaterThan(
      fixed.filter((row) => row.compactions > 0).length,
    );
  });
});
