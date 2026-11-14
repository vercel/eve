import type { HostUnderTest } from "#internal/testing/session-host/host-under-test.js";
import { alice } from "#internal/testing/session-host/probe.js";

import { benchMessage, createBenchAgent } from "./agent.js";
import type { BenchCounters, BenchHost } from "./hosts.js";
import { round, slope, summarize, type Summary } from "./stats.js";

// The host bench: the same conversations on each host, timed from the client's side through the
// host's `Runtime` (send a message, follow the session's stream), with the host settled before
// each measured turn so it starts idle. Times are milliseconds from the send.

export interface BenchConfig {
  /** Measured iterations of each scenario. */
  readonly iterations: number;
  /** Iterations run first and thrown away. */
  readonly warmup: number;
  /** Sequential tool calls in a tool turn, one scenario each. */
  readonly toolCounts: readonly number[];
  /** Prior turns before a measured turn in the history scenario. */
  readonly historyTurns: readonly number[];
  /** Measured iterations of the history scenario, which runs max(historyTurns) + 1 turns each. */
  readonly historyIterations: number;
}

/** One turn as the client saw it. */
interface TurnTiming {
  /** `send()` resolved: the host accepted the message. */
  readonly sendMs: number;
  /** The turn's first `content.delta` arrived. */
  readonly firstDeltaMs: number | undefined;
  /** The turn's `turn.settled` arrived. */
  readonly settledMs: number;
  /** Gaps between consecutive `call.settled` events: one model step and one tool call each. */
  readonly stepGapsMs: readonly number[];
  readonly events: number;
  readonly lines: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
}

/** Per-scenario metrics: a distribution for each measured quantity. */
export type ScenarioResult = Record<string, Summary | number | undefined>;

export interface HostBenchResult {
  readonly scenarios: Record<string, ScenarioResult>;
  /** How long each history turn took, by prior turns, median over iterations. */
  readonly historyCurve: readonly { turns: number; settledMs: number; firstDeltaMs: number }[];
}

/** A session on a host, driven turn by turn. */
class BenchSession {
  #next = 0;
  sessionId: string | undefined;
  readonly #host: HostUnderTest;
  readonly #token: string;

  constructor(host: HostUnderTest, token: string) {
    this.#host = host;
    this.#token = token;
  }

  /** Opens the session's stream at its last line and reads that line, as a reconnecting client. */
  async tailRead(): Promise<number> {
    const start = performance.now();
    const reader = (
      await this.#host.runtime.getEventStream(this.sessionId!, {
        follow: false,
        startIndex: this.#next - 1,
      })
    ).getReader();
    try {
      await reader.read();
    } finally {
      await reader.cancel().catch(() => {});
    }
    return performance.now() - start;
  }

  async turn(message: string): Promise<TurnTiming> {
    const { runtime } = this.#host;
    const start = performance.now();
    const delivery = await alice(runtime, this.#token).send(message, { auth: null });
    const sendMs = performance.now() - start;
    if (this.sessionId !== undefined && delivery.sessionId !== this.sessionId)
      throw new Error(`The session moved from ${this.sessionId} to ${delivery.sessionId}.`);
    this.sessionId = delivery.sessionId;
    const reader = (
      await runtime.getEventStream(delivery.sessionId, {
        signal: AbortSignal.timeout(300_000),
        startIndex: this.#next,
      })
    ).getReader();
    let firstDeltaMs: number | undefined;
    const settledCalls: number[] = [];
    let events = 0;
    let modelCalls = 0;
    let lastLine = this.#next - 1;
    const lines = new Set<number>();
    try {
      for (let next = await reader.read(); ; next = await reader.read()) {
        if (next.done) throw new Error("The session's stream ended before its turn settled.");
        const event = next.value;
        const at = performance.now() - start;
        events += 1;
        lines.add(event.meta.position.line);
        lastLine = Math.max(lastLine, event.meta.position.line);
        if (event.type === "content.delta") firstDeltaMs ??= at;
        else if (event.type === "model.requested") modelCalls += 1;
        else if (event.type === "call.settled") settledCalls.push(at);
        else if (event.type === "session.ended") throw new Error("The session ended mid-turn.");
        else if (event.type === "turn.settled") {
          if (event.data.outcome !== "completed")
            throw new Error(`The turn settled ${event.data.outcome}.`);
          this.#next = lastLine + 1;
          return {
            sendMs,
            firstDeltaMs,
            settledMs: at,
            stepGapsMs: settledCalls.slice(1).map((time, index) => time - settledCalls[index]!),
            events,
            lines: lines.size,
            modelCalls,
            toolCalls: settledCalls.length,
          };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/** Collected samples of one scenario. */
class Samples {
  readonly #values = new Map<string, number[]>();
  add(key: string, value: number | undefined): void {
    if (value === undefined) return;
    const list = this.#values.get(key) ?? [];
    list.push(value);
    this.#values.set(key, list);
  }
  addTurn(prefix: string, turn: TurnTiming): void {
    this.add(`${prefix}sendMs`, turn.sendMs);
    this.add(`${prefix}firstDeltaMs`, turn.firstDeltaMs);
    this.add(`${prefix}settledMs`, turn.settledMs);
    this.add(`${prefix}events`, turn.events);
    this.add(`${prefix}lines`, turn.lines);
    this.add(`${prefix}modelCalls`, turn.modelCalls);
    this.add(`${prefix}toolCalls`, turn.toolCalls);
    for (const gap of turn.stepGapsMs) this.add(`${prefix}stepGapMs`, gap);
    // Whether steps get slower as the turn goes on: ms each step adds to the next one's gap.
    this.add(
      `${prefix}stepGapGrowthMs`,
      slope(
        turn.stepGapsMs.map((_, index) => index),
        turn.stepGapsMs,
      ),
    );
  }
  addCounts(prefix: string, counts: Record<string, number>): void {
    for (const [key, value] of Object.entries(counts)) this.add(`${prefix}${key}`, value);
  }
  get(key: string): readonly number[] {
    return this.#values.get(key) ?? [];
  }
  result(): ScenarioResult {
    return Object.fromEntries(
      [...this.#values].map(([key, values]) => [key, summarize(values)] as const),
    );
  }
}

const diff = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(after)
      .map(([key, value]) => [key, value - (before[key] ?? 0)] as const)
      .filter(([, value]) => value !== 0),
  );

interface Context {
  readonly host: BenchHost;
  readonly counters: BenchCounters | undefined;
  /** Each session's own continuation token. */
  token(): string;
}

/** Runs `body` against a fresh host `warmup + iterations` times, keeping the measured ones. */
async function iterate(
  context: Context,
  iterations: number,
  warmup: number,
  body: (host: HostUnderTest, samples: Samples) => Promise<void>,
): Promise<Samples> {
  const kept = new Samples();
  for (let i = 0; i < warmup + iterations; i++) {
    const samples = i < warmup ? new Samples() : kept;
    const host = await context.host.kind.make();
    try {
      await body(host, samples);
    } finally {
      await host.dispose();
    }
  }
  return kept;
}

/** Runs one measured turn on an idle host, counting the host's work until it is idle again. */
async function measuredTurn(
  context: Context,
  host: HostUnderTest,
  session: BenchSession,
  message: string,
  samples: Samples,
  prefix = "",
): Promise<TurnTiming> {
  await host.settled();
  const before = context.counters?.read() ?? {};
  const turn = await session.turn(message);
  samples.addTurn(prefix, turn);
  const settleStart = performance.now();
  await host.settled();
  samples.add(`${prefix}tailMs`, performance.now() - settleStart);
  if (context.counters !== undefined)
    samples.addCounts(prefix, diff(context.counters.read(), before));
  samples.add(`${prefix}tailReadMs`, await session.tailRead());
  return turn;
}

/** Runs every scenario on `host` and returns its results. Call it inside a Workflow test file. */
export async function runHostBench(
  name: string,
  host: BenchHost,
  config: BenchConfig,
  log: (line: string) => void = () => {},
): Promise<HostBenchResult> {
  const agent = await createBenchAgent(`host-bench-${name}`);
  let sessions = 0;
  return await agent.run(async () => {
    const counters = host.count?.();
    const context: Context = {
      host,
      counters,
      token: () => `host-bench:${name}:${Date.now()}:${sessions++}`,
    };
    const { iterations, warmup } = config;
    const scenarios: Record<string, ScenarioResult> = {};
    try {
      // 1. A new session's first turn: start to first token.
      log(`${name}: first turn`);
      scenarios["first-turn"] = (
        await iterate(context, iterations, warmup, async (h, samples) => {
          await measuredTurn(
            context,
            h,
            new BenchSession(h, context.token()),
            benchMessage("hello"),
            samples,
          );
        })
      ).result();

      // 3. A follow-up on an idle session.
      log(`${name}: follow-up`);
      scenarios["follow-up"] = (
        await iterate(context, iterations, warmup, async (h, samples) => {
          const session = new BenchSession(h, context.token());
          await session.turn(benchMessage("hello"));
          await measuredTurn(context, h, session, benchMessage("again"), samples);
        })
      ).result();

      // 2. Follow-up turns with N sequential tool calls.
      for (const tools of config.toolCounts) {
        log(`${name}: ${tools} tool calls`);
        const samples = await iterate(context, iterations, warmup, async (h, samples) => {
          const session = new BenchSession(h, context.token());
          await session.turn(benchMessage("hello"));
          const turn = await measuredTurn(
            context,
            h,
            session,
            benchMessage("work", tools),
            samples,
          );
          if (turn.toolCalls !== tools)
            throw new Error(`Expected ${tools} tool calls, the turn made ${turn.toolCalls}.`);
        });
        const result = samples.result();
        const base = scenarios["follow-up"]!["settledMs"] as Summary | undefined;
        const turn = result["settledMs"] as Summary | undefined;
        // What each tool step adds over a plain follow-up turn, from the medians.
        if (base !== undefined && turn !== undefined)
          result["perStepMs"] = round((turn.median - base.median) / tools);
        scenarios[`tools-${tools}`] = result;
      }

      // 4. Session length: a turn after K prior turns, in one session per iteration.
      const maxTurns = Math.max(...config.historyTurns);
      const checkpoints = new Set(config.historyTurns);
      const curve = new Map<number, { settled: number[]; delta: number[] }>();
      log(`${name}: history to ${maxTurns} turns`);
      const history = await iterate(context, config.historyIterations, 0, async (h, samples) => {
        const session = new BenchSession(h, context.token());
        for (let prior = 0; prior <= maxTurns; prior++) {
          const prefix = checkpoints.has(prior) ? `k${prior}.` : "rest.";
          const turn = await measuredTurn(
            context,
            h,
            session,
            benchMessage(`turn ${prior}`),
            samples,
            prefix,
          );
          const point = curve.get(prior) ?? { settled: [], delta: [] };
          point.settled.push(turn.settledMs);
          if (turn.firstDeltaMs !== undefined) point.delta.push(turn.firstDeltaMs);
          curve.set(prior, point);
        }
      });
      const historyResult = history.result();
      for (const key of Object.keys(historyResult))
        if (key.startsWith("rest.")) delete historyResult[key];
      const historyCurve = [...curve].map(([turns, point]) => ({
        turns,
        settledMs: summarize(point.settled)!.median,
        firstDeltaMs: summarize(point.delta)?.median ?? Number.NaN,
      }));
      // Growth per prior turn, fit over follow-up turns (turn 0 also starts the session).
      const followUps = historyCurve.filter(({ turns }) => turns > 0);
      historyResult["settledMsPerPriorTurn"] = slope(
        followUps.map(({ turns }) => turns),
        followUps.map(({ settledMs }) => settledMs),
      );
      scenarios["history"] = historyResult;
      return { scenarios, historyCurve };
    } finally {
      counters?.restore();
    }
  });
}
