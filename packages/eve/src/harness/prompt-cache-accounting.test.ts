import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  type AnthropicCacheMarker,
  applyConversationCacheControl,
  getAnthropicCacheMarker,
} from "#harness/prompt-cache.js";

/**
 * Deterministic replay of two production benchmark traces that reported
 * ~45–48% prompt cache hit rates.
 *
 * A small simulator implements Anthropic's prefix-cache accounting rules:
 *
 * - `cache_read`  = the previously cached prefix (when it still prefixes
 *   the request and ends at or before the last breakpoint),
 * - `cache_write` = tokens between the read prefix and the last breakpoint,
 * - `input`       = tokens after the last breakpoint (billed uncached,
 *   never written).
 *
 * Driving the simulator with the legacy breakpoint placement (last
 * assistant + last user, tool messages skipped) reproduces the traces'
 * recorded `turn_usage` token-for-token on every turn after the first —
 * proving the observed percentages were caused by breakpoint placement,
 * not by cache invalidation. The fixed placement (last message + prior
 * assistant anchor) run on the identical workload eliminates all uncached
 * input: every token is written to the cache in the request that first
 * carries it, which is the accounting optimum.
 *
 * Convention: 1 character = 1 token, so message sizes are exact.
 */

// ---------------------------------------------------------------------------
// Token-sized message builders
// ---------------------------------------------------------------------------

function userMessage(tokens: number): ModelMessage {
  return { role: "user", content: "x".repeat(tokens) };
}

function assistantMessage(tokens: number): ModelMessage {
  return { role: "assistant", content: "x".repeat(tokens) };
}

function toolResultMessage(tokens: number): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "fetch",
        output: { type: "text", value: "x".repeat(tokens) },
      },
    ],
  };
}

function tokensOf(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") {
      total += part.text.length;
    } else if (part.type === "tool-result" && part.output.type === "text") {
      total += part.output.value.length;
    }
  }
  return total;
}

function isMarked(message: ModelMessage): boolean {
  const options = message.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined;
  return options?.anthropic?.cacheControl !== undefined;
}

// ---------------------------------------------------------------------------
// Anthropic prefix-cache accounting simulator
// ---------------------------------------------------------------------------

interface TurnUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

class PrefixCacheAccounting {
  private cachedPrefixTokens: number;

  constructor(warmPrefixTokens: number) {
    this.cachedPrefixTokens = warmPrefixTokens;
  }

  /**
   * Accounts one request. `baseTokens` models the system prompt and tool
   * definitions, which the harness always covers with their own
   * breakpoints (`applySystemCacheBreakpoint`, `applyLastToolCacheBreakpoint`).
   */
  request(baseTokens: number, messages: readonly ModelMessage[]): TurnUsage {
    let total = baseTokens;
    let lastBreakpoint = baseTokens;
    for (const message of messages) {
      total += tokensOf(message);
      if (isMarked(message)) {
        lastBreakpoint = total;
      }
    }
    const cacheRead = Math.min(this.cachedPrefixTokens, lastBreakpoint);
    const cacheWrite = lastBreakpoint - cacheRead;
    const input = total - lastBreakpoint;
    this.cachedPrefixTokens = Math.max(this.cachedPrefixTokens, lastBreakpoint);
    return { input, cacheRead, cacheWrite };
  }
}

// ---------------------------------------------------------------------------
// Legacy breakpoint placement (pre-fix), preserved to prove the regression
// ---------------------------------------------------------------------------

function legacyApplyConversationCacheControl(
  messages: readonly ModelMessage[],
  marker: AnthropicCacheMarker,
): ModelMessage[] {
  const out = [...messages];
  let foundAssistant = false;
  let foundUser = false;

  for (let i = out.length - 1; i >= 0 && (!foundAssistant || !foundUser); i--) {
    const message = out[i];
    if (message === undefined) continue;

    if (!foundAssistant && message.role === "assistant") {
      out[i] = { ...message, providerOptions: { ...message.providerOptions, ...marker } };
      foundAssistant = true;
    } else if (!foundUser && message.role === "user") {
      out[i] = { ...message, providerOptions: { ...message.providerOptions, ...marker } };
      foundUser = true;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Benchmark trace workloads
// ---------------------------------------------------------------------------

interface TraceScenario {
  readonly name: string;
  /** System prompt + tool definitions, always behind their own breakpoints. */
  readonly systemAndTools: number;
  /** The initial user task message. */
  readonly userTask: number;
  /** Cache warmth carried over from a sibling run sharing the system prefix. */
  readonly warmPrefix: number;
  /**
   * Serialized size of each assistant message when it re-enters the prompt.
   * Derived from the trace identity `cache_write(t+1) - input(t)`.
   */
  readonly assistantTurns: readonly number[];
  /** Tool results appended after each turn. Derived from `input(t+1)`. */
  readonly toolResults: readonly number[];
  /** `turn_usage` as recorded in the benchmark trace JSON. */
  readonly observed: readonly TurnUsage[];
  /** Exact served-from-cache rate under the legacy breakpoint placement. */
  readonly legacyServedFromCache: number;
  /** Exact served-from-cache rate under the fixed breakpoint placement. */
  readonly fixedServedFromCache: number;
}

const SCENARIOS: readonly TraceScenario[] = [
  {
    // Run 3c803a51-bb6a-4a05-88a5-42ca75f49fa5, claude-fable-5, 5 turns.
    name: "3c803a51 (claude-fable-5)",
    systemAndTools: 4565,
    userTask: 782,
    warmPrefix: 4565,
    assistantTurns: [168, 180, 127, 151],
    toolResults: [4466, 568, 7702, 19286],
    observed: [
      { input: 2, cacheRead: 4565, cacheWrite: 782 },
      { input: 4466, cacheRead: 5347, cacheWrite: 168 },
      { input: 568, cacheRead: 5515, cacheWrite: 4646 },
      { input: 7702, cacheRead: 10161, cacheWrite: 695 },
      { input: 19286, cacheRead: 10856, cacheWrite: 7853 },
    ],
    // 36444 read / (36444 read + 32022 input + 14144 write) = 44.12%
    legacyServedFromCache: 0.441157,
    // 49180 read / (49180 read + 0 input + 33430 write) = 59.53%
    fixedServedFromCache: 0.595327,
  },
  {
    // Run e7757164-b009-4bea-9a7f-f97d2e18ea9f, claude-haiku-4-5, 7 turns.
    name: "e7757164 (claude-haiku-4-5)",
    systemAndTools: 4179,
    userTask: 0,
    warmPrefix: 0,
    assistantTurns: [222, 205, 217, 165, 160, 167],
    toolResults: [8149, 3547, 8144, 16433, 9911, 23482],
    observed: [
      { input: 3, cacheRead: 0, cacheWrite: 4179 },
      { input: 8149, cacheRead: 4179, cacheWrite: 222 },
      { input: 3547, cacheRead: 4401, cacheWrite: 8354 },
      { input: 8144, cacheRead: 12755, cacheWrite: 3764 },
      { input: 16433, cacheRead: 16519, cacheWrite: 8309 },
      { input: 9911, cacheRead: 24828, cacheWrite: 16593 },
      { input: 23482, cacheRead: 41421, cacheWrite: 10078 },
    ],
    // 104103 read / (104103 read + 69666 input + 51499 write) = 46.21%
    legacyServedFromCache: 0.46213,
    // 150287 read / (150287 read + 0 input + 74981 write) = 66.71%
    fixedServedFromCache: 0.667148,
  },
];

type BreakpointStrategy = (
  messages: readonly ModelMessage[],
  marker: AnthropicCacheMarker,
) => ModelMessage[];

function replayToolLoop(scenario: TraceScenario, strategy: BreakpointStrategy): TurnUsage[] {
  const marker = getAnthropicCacheMarker();
  const accounting = new PrefixCacheAccounting(scenario.warmPrefix);
  const history: ModelMessage[] = [userMessage(scenario.userTask)];
  const usage: TurnUsage[] = [];

  for (let turn = 0; turn < scenario.observed.length; turn++) {
    usage.push(accounting.request(scenario.systemAndTools, strategy(history, marker)));
    if (turn < scenario.observed.length - 1) {
      history.push(
        assistantMessage(scenario.assistantTurns[turn]!),
        toolResultMessage(scenario.toolResults[turn]!),
      );
    }
  }

  return usage;
}

/** Fraction of all prompt tokens served from cache: read / (read + input + write). */
function servedFromCache(usage: readonly TurnUsage[]): number {
  let read = 0;
  let uncached = 0;
  for (const turn of usage) {
    read += turn.cacheRead;
    uncached += turn.input + turn.cacheWrite;
  }
  return read / (read + uncached);
}

/** Fraction of previously seen prompt tokens served from cache: read / (read + input). */
function inputCacheRate(usage: readonly TurnUsage[]): number {
  let read = 0;
  let input = 0;
  for (const turn of usage) {
    read += turn.cacheRead;
    input += turn.input;
  }
  return read / (read + input);
}

// ---------------------------------------------------------------------------
// Grep-heavy coding session
// ---------------------------------------------------------------------------

/**
 * Deterministic grep-shaped output: `path:line: code` match lines, the way a
 * search tool floods a coding agent's context. These are the largest tool
 * results in practice, which makes them the costliest content to leave
 * outside the final cache breakpoint.
 */
function grepOutput(query: string, matches: number): string {
  const lines: string[] = [];
  for (let i = 0; i < matches; i++) {
    lines.push(
      `src/module-${i % 23}/file-${i % 7}.ts:${100 + i}:  ` +
        `const ${query}Result${i} = resolve${i % 5}(${query}, ctx.session);`,
    );
  }
  return lines.join("\n");
}

/** One tool message carrying one or more tool results (parallel calls). */
function grepResultsMessage(outputs: readonly string[]): ModelMessage {
  return {
    role: "tool",
    content: outputs.map((text, index) => ({
      type: "tool-result",
      toolCallId: `call-${index}`,
      toolName: "grep",
      output: { type: "text", value: text },
    })),
  };
}

interface GrepStep {
  /** Assistant commentary + tool-call framing preceding the results. */
  readonly commentary: number;
  /** Grep outputs returned by this step's tool call(s). */
  readonly results: readonly string[];
}

const GREP_SESSION: readonly GrepStep[] = [
  { commentary: 140, results: [grepOutput("applyConversationCacheControl", 80)] },
  // A broad query floods the context, the classic coding-agent step.
  { commentary: 130, results: [grepOutput("cacheControl", 340)] },
  // Parallel fan-out: three greps land in one tool message.
  {
    commentary: 160,
    results: [
      grepOutput("providerOptions", 200),
      grepOutput("ephemeral", 190),
      grepOutput("breakpoint", 210),
    ],
  },
  { commentary: 120, results: [grepOutput("prepareStep", 130)] },
  { commentary: 150, results: [grepOutput("toolResult", 760)] },
];

const GREP_BASE_TOKENS = 3200;
const GREP_TASK_TOKENS = 900;

function replayGrepSession(strategy: BreakpointStrategy): TurnUsage[] {
  const marker = getAnthropicCacheMarker();
  const accounting = new PrefixCacheAccounting(0);
  const history: ModelMessage[] = [userMessage(GREP_TASK_TOKENS)];
  const usage: TurnUsage[] = [];

  for (const step of GREP_SESSION) {
    usage.push(accounting.request(GREP_BASE_TOKENS, strategy(history, marker)));
    history.push(assistantMessage(step.commentary), grepResultsMessage(step.results));
  }

  // Final step: the model reads the last grep results and answers.
  usage.push(accounting.request(GREP_BASE_TOKENS, strategy(history, marker)));
  return usage;
}

function totalGrepTokens(): number {
  let total = 0;
  for (const step of GREP_SESSION) {
    for (const text of step.results) {
      total += text.length;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe("prompt cache accounting replayed from benchmark traces", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      it("legacy placement reproduces the recorded turn_usage token-for-token", () => {
        const usage = replayToolLoop(scenario, legacyApplyConversationCacheControl);

        // Turn 1 differs only by the trace's 2–3 structural overhead tokens
        // (request framing not attributable to any message).
        expect(usage[0]!.cacheRead).toBe(scenario.observed[0]!.cacheRead);
        expect(usage[0]!.cacheWrite).toBe(scenario.observed[0]!.cacheWrite);

        // Every subsequent turn matches the trace exactly on all three
        // columns: the reported hit rate is fully explained by placement.
        expect(usage.slice(1)).toEqual(scenario.observed.slice(1));
      });

      it("legacy placement yields the exact reported served-from-cache percentage", () => {
        const usage = replayToolLoop(scenario, legacyApplyConversationCacheControl);
        const simulated = servedFromCache(usage);
        const observed = servedFromCache(scenario.observed);

        // The simulated rate matches both the rate computed from the raw
        // trace and the hardcoded expected value — 44.12% (fable) and
        // 46.21% (haiku), the numbers behind the "45–48%" reports.
        expect(Math.abs(simulated - observed)).toBeLessThan(0.001);
        expect(simulated).toBeCloseTo(scenario.legacyServedFromCache, 5);
      });

      it("fixed placement yields the exact predicted served-from-cache percentage", () => {
        const usage = replayToolLoop(scenario, applyConversationCacheControl);

        // 59.53% (fable) and 66.71% (haiku) — the workload ceiling, since
        // every remaining non-read token is a mandatory first-time write.
        expect(servedFromCache(usage)).toBeCloseTo(scenario.fixedServedFromCache, 5);
      });

      it("fixed placement eliminates uncached input entirely on the same workload", () => {
        const usage = replayToolLoop(scenario, applyConversationCacheControl);

        for (const turn of usage) {
          expect(turn.input).toBe(0);
        }
      });

      it("fixed placement writes every token exactly once (accounting optimum)", () => {
        const usage = replayToolLoop(scenario, applyConversationCacheControl);

        const finalRequestTokens =
          scenario.systemAndTools +
          scenario.userTask +
          scenario.assistantTurns.reduce((a, b) => a + b, 0) +
          scenario.toolResults.reduce((a, b) => a + b, 0);
        const totalWrites =
          scenario.warmPrefix + usage.reduce((sum, turn) => sum + turn.cacheWrite, 0);

        expect(totalWrites).toBe(finalRequestTokens);
      });

      it("fixed placement beats legacy served-from-cache on the same workload", () => {
        const legacy = servedFromCache(
          replayToolLoop(scenario, legacyApplyConversationCacheControl),
        );
        const fixed = servedFromCache(replayToolLoop(scenario, applyConversationCacheControl));

        expect(fixed).toBeGreaterThan(legacy);
      });
    });
  }
});

describe("grep-heavy coding session", () => {
  it("legacy placement bills every grep result at the uncached rate exactly once", () => {
    const usage = replayGrepSession(legacyApplyConversationCacheControl);

    const uncached = usage.reduce((sum, turn) => sum + turn.input, 0);
    expect(uncached).toBe(totalGrepTokens());
  });

  it("legacy placement caps the input-cache rate near 50%", () => {
    const rate = inputCacheRate(replayGrepSession(legacyApplyConversationCacheControl));

    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.6);
  });

  it("fixed placement never bills a grep result uncached", () => {
    const usage = replayGrepSession(applyConversationCacheControl);

    for (const turn of usage) {
      expect(turn.input).toBe(0);
    }
    // Mirrors the agent-prompt-cache e2e gate.
    expect(inputCacheRate(usage)).toBeGreaterThan(0.99);
  });

  it("fixed placement covers parallel tool results with one trailing breakpoint", () => {
    // Reads always chain: read(t) equals everything cached through t-1, so
    // the multi-result fan-out step is fully re-read, never re-billed.
    const usage = replayGrepSession(applyConversationCacheControl);
    for (let i = 1; i < usage.length; i++) {
      expect(usage[i]!.cacheRead).toBe(usage[i - 1]!.cacheRead + usage[i - 1]!.cacheWrite);
    }

    const finalRequestTokens =
      GREP_BASE_TOKENS +
      GREP_TASK_TOKENS +
      GREP_SESSION.reduce((sum, step) => sum + step.commentary, 0) +
      totalGrepTokens();
    const totalWrites = usage.reduce((sum, turn) => sum + turn.cacheWrite, 0);
    expect(totalWrites).toBe(finalRequestTokens);
  });
});
