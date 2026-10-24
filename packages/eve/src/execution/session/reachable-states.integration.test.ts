import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { defineDynamic } from "#dynamic/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { selectorAnswers } from "#internal/testing/selector-answers.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { isStoredLine, type StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { activeTurn, waiting } from "#protocol/session-projection/selectors.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

// Sessions driven at random through the real session program: a scripted model, a tool that
// needs approval, one that holds until the driver lets it finish, and two people, Alice, whose
// turns they are, and Bob, who writes while she's busy. At every point the session waits, on a
// person or on the driver, the driver checks what the session's tables promise, then picks
// something to do: answer, steer, write as Bob, cancel, or let the model or tool go on. Every
// line also goes through the integration tier's contract checker and the step decision check.
//
// `EVE_SESSION_FUZZ_RUNS` and `EVE_SESSION_FUZZ_ACTIONS` raise the number and length of sessions,
// `EVE_SESSION_FUZZ_SEED` picks the first seed, and `EVE_SESSION_FUZZ_DELEGATE=1` lets the model
// delegate to child sessions. A finding names its seed and the driver's last moves;
// `EVE_SESSION_FUZZ_TRACE=1` also writes each session's lines and moves to the system's temporary
// directory, as `eve-session-fuzz-<seed>.ndjson`.

vi.setConfig({ testTimeout: 300_000 });

const RUNS = Number(process.env.EVE_SESSION_FUZZ_RUNS ?? 4);
const FIRST_SEED = Number(process.env.EVE_SESSION_FUZZ_SEED ?? 1);
/** Optional delegation expands the world beyond the default delivery/control sequences. */
const DELEGATE = process.env.EVE_SESSION_FUZZ_DELEGATE === "1";
const ACTIONS = Number(process.env.EVE_SESSION_FUZZ_ACTIONS ?? 16);
/** How long the stream and the workflow's event log stay unchanged before the session counts as waiting. */
const QUIET_MS = 300;
/** How many workflow events a session may record without writing a line before it counts as spinning. */
const SPINNING_EVENTS = 300;

const person = (principalId: string) => ({
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId,
  principalType: "user" as const,
});
const ALICE = person("alice");
/** How the session asks a child session for help, so the child can tell it's one. */
const CHILD = "CHILD:";
const BOB = person("bob");

type Prompt = LanguageModelV4CallOptions["prompt"];
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Something the session waits on the driver for: a model response, or a held tool. */
interface Gate {
  readonly kind: "model" | "tool";
  readonly prompt?: Prompt;
  readonly release: (response?: StreamResult) => void;
}

/** One session the driver runs. The agent's model and tools hand their work to it. */
class Episode {
  readonly gates: Gate[] = [];
  readonly sent: string[] = [];
  readonly moves: string[] = [];
  readonly findings: string[] = [];
  readonly complete = emptySessionView();
  readonly operational = emptySessionView();
  readonly random: () => number;
  /** Each turn's `turn.paused` announcements: the line, and whom it awaited. */
  readonly paused: {
    readonly line: number;
    readonly turnId: string;
    readonly awaiting: string[];
  }[] = [];
  changedAt = Date.now();
  /** The sessions this episode runs: its own, and the children it opened. */
  readonly sessions = new Set<string>();
  calls = 0;
  ended = false;

  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.random = rng(seed);
  }

  pick<T>(options: readonly (readonly [number, T])[]): T {
    const total = options.reduce((sum, [weight]) => sum + weight, 0);
    let at = this.random() * total;
    for (const [weight, value] of options) {
      at -= weight;
      if (at < 0) return value;
    }
    return options.at(-1)![1];
  }

  private readonly found = new Set<string>();

  /** Records a broken promise once, with the moves that led to it. */
  find(finding: string): void {
    if (this.found.has(finding)) return;
    this.found.add(finding);
    this.findings.push(`seed ${this.seed}: ${finding} (after ${this.moves.slice(-6).join(", ")})`);
  }

  /** Folds one line both ways, and holds the operational view to the selectors it promises. */
  fold(line: StoredLine): void {
    const position = this.complete.position;
    trace(this.seed, { line: position, ...line });
    foldLine(this.complete, line, position);
    foldLine(this.operational, line, position, { retention: "operational" });
    this.changedAt = Date.now();
    if (
      JSON.stringify(selectorAnswers(this.complete, this.operational)) !==
      JSON.stringify(selectorAnswers(this.operational))
    )
      this.find(`an operational view answers otherwise at line ${position}`);
    if (!("facts" in line)) return;
    for (const fact of line.facts as readonly SessionEvent[]) {
      if (fact.type === "turn.paused")
        this.paused.push({
          awaiting: fact.data.awaiting.map((entry) => entry.interactionId),
          line: position,
          turnId: fact.data.turnId,
        });
      if (fact.type === "turn.settled" && fact.data.outcome === "failed")
        this.find(`turn ${fact.data.turnId} failed: ${JSON.stringify(fact.data.error)}`);
      if (fact.type === "child.opened") this.sessions.add(fact.data.sessionId);
      if (fact.type === "session.ended") {
        this.ended = true;
        if (fact.data.outcome === "failed")
          this.find(`the session failed: ${JSON.stringify(fact.data.error)}`);
      }
    }
  }

  /** The model's next response, once the driver decides it. */
  async respond(prompt: Prompt, signal: AbortSignal | undefined): Promise<StreamResult> {
    return await new Promise<StreamResult>((resolve, reject) => {
      const gate: Gate = { kind: "model", prompt, release: (response) => resolve(response!) };
      this.gates.push(gate);
      signal?.addEventListener("abort", () => {
        this.remove(gate);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      });
    });
  }

  /** Holds a tool until the driver lets it finish. */
  async hold(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.gates.push({ kind: "tool", release: () => resolve() }),
    );
  }

  remove(gate: Gate): void {
    const index = this.gates.indexOf(gate);
    if (index !== -1) this.gates.splice(index, 1);
  }
}

let episode: Episode | undefined;
const current = () => {
  if (episode === undefined) throw new Error("No session is being driven.");
  return episode;
};

/**
 * The episode a model call belongs to, by the seed its conversation names. A session an earlier
 * episode left behind, such as a child still finishing, gets an answer at once.
 */
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ abortSignal, prompt }) => {
      const seed = /(?:Hello|CHILD:)(\d+)/.exec(JSON.stringify(prompt))?.[1];
      if (episode === undefined || String(episode.seed) !== seed) return textStreamResult("Done.");
      return await episode.respond(prompt, abortSignal);
    },
    modelId: "fuzzed",
    provider: "eve-test",
  }),
);

let runtime: TestRuntime;

beforeAll(async () => {
  runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "fuzzed",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Look something up.",
            execute: async () => ({ found: true }),
            inputSchema: z.object({}).passthrough(),
          }),
        }),
        logicalPath: "tools/lookup.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineTool({
            approval: { request: always() },
            description: "Deploy, once someone approves.",
            execute: async () => ({ deployed: true }),
            inputSchema: z.object({}).passthrough(),
          }),
        }),
        logicalPath: "tools/deploy.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Build, which takes a while.",
            execute: async () => {
              await current().hold();
              return { built: true };
            },
            inputSchema: z.object({}).passthrough(),
          }),
        }),
        logicalPath: "tools/build.ts",
      },
    ],
  });
});

afterAll(() => {
  episode = undefined;
});

/**
 * The number of events the workflow has recorded for the runs started since `since`: the session
 * and the child sessions it opened. It grows while any of them works.
 */
async function workflowEventCount(since: Date): Promise<number> {
  const world = await getWorld();
  const runIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: cursor === undefined ? { limit: 1000 } : { cursor, limit: 1000 },
      resolveData: "none",
    });
    for (const run of page.data) if (run.createdAt >= since) runIds.push(run.runId);
    cursor = page.hasMore && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);
  let count = 0;
  for (const runId of runIds) {
    let events: string | undefined;
    do {
      const page = await world.events.list({
        pagination: { cursor: events, limit: 1000 },
        resolveData: "none",
        runId,
      });
      count += page.data.length;
      events = page.hasMore === true && page.cursor !== null ? page.cursor : undefined;
    } while (events !== undefined);
  }
  return count;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records a line or a move of the session `seed` drives, with `EVE_SESSION_FUZZ_TRACE=1`. */
function trace(seed: number, record: object): void {
  if (process.env.EVE_SESSION_FUZZ_TRACE !== "1") return;
  appendFileSync(join(tmpdir(), `eve-session-fuzz-${seed}.ndjson`), `${JSON.stringify(record)}\n`);
}

/**
 * Why each step that failed and was tried again failed, in the runs started since `since`. A step
 * fails on a line the stream's contract refuses, and the retry writes on top of what it wrote.
 */
async function stepRetries(since: Date): Promise<readonly string[]> {
  const world = await getWorld();
  const page = await world.runs.list({ pagination: { limit: 1000 }, resolveData: "none" });
  const reasons: string[] = [];
  for (const run of page.data) {
    if (run.createdAt < since) continue;
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId: run.runId,
    });
    for (const event of events.data) {
      if (event.eventType !== "step_retrying") continue;
      const error = (event as { eventData?: { error?: Record<string, number> } }).eventData?.error;
      const text = Buffer.from(Object.values(error ?? {})).toString("utf8");
      reasons.push(/"Error","([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 200));
    }
  }
  return reasons;
}

/** Drives one session; returns what it found. */
async function drive(seed: number): Promise<readonly string[]> {
  const run = new Episode(seed);
  episode = run;
  const warn = vi.spyOn(console, "warn");
  const continuationToken = `http:fuzz-${seed}`;
  const startedAt = new Date();
  await runtime.run(async () => {
    const owner = await startSessionOwner(workflowEntry, [
      {
        input: { message: `Hello${seed}` },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    run.sessions.add(owner.runId);
    const commands = sessionInboxHookToken(sessionCommandHookToken(owner.runId));
    const reading = readLines(owner.readable, run);

    const send = async (from: typeof ALICE, payload: object, label: string) => {
      const delivery = createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" });
      run.sent.push(delivery.deliveryId);
      run.moves.push(label);
      trace(seed, { deliveryId: delivery.deliveryId, move: label, payload });
      await resumeHook(sessionInboxHookToken(continuationToken), {
        auth: from,
        delivery,
        kind: "send",
        payload,
      });
    };
    const message = (from: typeof ALICE) =>
      send(from, { message: `A note from ${from.principalId}` }, `${from.principalId} writes`);
    const control = async (kind: "clear" | "compact") => {
      const deliveryId = `${kind}_${run.sent.length}`;
      run.sent.push(deliveryId);
      run.moves.push(kind);
      await resumeHook(commands, { auth: ALICE, deliveryId, kind });
    };
    const cancel = async () => {
      const deliveryId = `cancel_${run.sent.length}`;
      run.sent.push(deliveryId);
      run.moves.push("cancel");
      await resumeHook(commands, { auth: ALICE, deliveryId, kind: "cancel" });
    };
    /** Something that arrives while the session is busy, or nothing. */
    const arrival = async () => {
      const act = run.pick([
        [6, undefined],
        [2, () => message(ALICE)],
        [2, () => message(BOB)],
        [1, cancel],
      ] as const);
      if (act === undefined) return;
      await act();
      // Let the session take it in before the gate opens, so steering can land.
      await sleep(100);
    };

    /** Waits for the session to wait: on a gate, or with nothing changing. */
    const stop = async (): Promise<"gate" | "quiet" | "ended" | "spinning"> => {
      let events = await workflowEventCount(startedAt);
      let since = Date.now();
      let line = run.complete.position;
      let eventsAtLine = events;
      const deadline = Date.now() + 30_000;
      while (true) {
        if (Date.now() > deadline)
          throw new Error(`Seed ${seed} did not reach a gate or quiet boundary.`);
        if (run.ended) return "ended";
        if (run.gates.length > 0) return "gate";
        await sleep(50);
        const now = await workflowEventCount(startedAt);
        if (now !== events) {
          events = now;
          since = Date.now();
        }
        // A session that keeps taking steps without writing a line spins: it does nothing, and
        // never waits.
        if (run.complete.position !== line) {
          line = run.complete.position;
          eventsAtLine = events;
        } else if (events - eventsAtLine > SPINNING_EVENTS) return "spinning";
        // A session that hasn't written yet is still starting, compiling its agent first.
        if (
          run.complete.position > 0 &&
          Date.now() - Math.max(since, run.changedAt) > QUIET_MS &&
          run.gates.length === 0
        )
          return "quiet";
      }
    };

    const respond = (gate: Gate, finishing: boolean) => {
      run.remove(gate);
      if (gate.kind === "tool") {
        run.moves.push("build finishes");
        gate.release();
        return;
      }
      const afterTools = gate.prompt?.at(-1)?.role === "tool";
      // A child session's conversation starts with what its parent asked; it delegates no further.
      const child = JSON.stringify(
        gate.prompt?.find((message) => message.role === "user"),
      ).includes(`${CHILD}${seed}`);
      const choice = finishing
        ? "reply"
        : run.pick([
            [afterTools ? 6 : 4, "reply"],
            [2, "lookup"],
            [2, "deploy"],
            [2, "build"],
            [1, "deploy+lookup"],
            [1, "build+deploy"],
            [1, "deploy+deploy"],
            [child || !DELEGATE ? 0 : 2, "agent"],
            [child || !DELEGATE ? 0 : 1, "agent+eve__task_wait"],
          ] as const);
      run.moves.push(`model: ${choice}`);
      gate.release(
        choice === "reply"
          ? textStreamResult("Done.")
          : toolCallsStreamResult(
              choice.split("+").map((toolName) => ({
                input:
                  toolName === "agent"
                    ? JSON.stringify({ message: `${CHILD}${seed} help out` })
                    : "{}",
                toolCallId: `call_${run.calls++}`,
                toolName,
              })),
            ),
      );
    };

    /** What the tables promise once the session waits with nothing in flight. */
    const checkQuiet = () => {
      const view = run.complete;
      for (const deliveryId of run.sent)
        if (view.deliveries[deliveryId] === undefined)
          run.find(`delivery ${deliveryId} arrived, but the view doesn't hold it`);
      const turn = activeTurn(view);
      if (turn === undefined) return;
      const waits = waiting(view, turn.turnId);
      if (waits?.on === "session")
        run.find(`turn ${turn.turnId} reads as the session's work while it waits`);
      if (waits?.on === "work") run.find(`turn ${turn.turnId} waits on work with nothing running`);
      if (waits?.on === "interaction")
        for (const row of waits.interactions)
          if (
            !run.paused.some(
              (pause) =>
                pause.turnId === turn.turnId &&
                pause.line >= row.introducedAt &&
                pause.awaiting.includes(row.interactionId),
            )
          )
            run.find(`turn ${turn.turnId} waits on ${row.interactionId} without announcing it`);
    };

    const answer = async (finishing: boolean) => {
      const turn = activeTurn(run.complete);
      const waits = turn === undefined ? undefined : waiting(run.complete, turn.turnId);
      if (waits?.on !== "interaction") return false;
      const [first] = waits.interactions;
      if (first === undefined) return false;
      // To finish, the person whose turn it is answers, as only they may.
      const cause = turn!.cause;
      const owner =
        cause !== undefined && "deliveryId" in cause
          ? run.complete.deliveries[cause.deliveryId]?.principal?.id
          : undefined;
      const by = finishing
        ? owner === BOB.principalId
          ? BOB
          : ALICE
        : run.pick([
            [3, ALICE],
            [1, BOB],
          ] as const);
      const optionId = finishing
        ? "approve"
        : run.pick([
            [3, "approve"],
            [1, "deny"],
          ] as const);
      await send(
        by,
        { answers: [{ interactionId: first.interactionId, optionId }] },
        `${by.principalId} answers ${optionId}`,
      );
      return true;
    };

    let spun = false;
    try {
      for (let move = 0; move < ACTIONS; move += 1) {
        const at = await stop();
        if (at === "ended") break;
        if (at === "spinning") {
          run.find("the session takes steps without writing anything");
          spun = true;
          break;
        }
        if (at === "gate") {
          await arrival();
          const gate = run.gates[0];
          if (gate !== undefined) respond(gate, false);
          continue;
        }
        checkQuiet();
        const turn = activeTurn(run.complete);
        if (turn === undefined) {
          await run.pick([
            [6, () => message(ALICE)],
            [2, () => message(BOB)],
            [1, () => control("compact")],
            [1, () => control("clear")],
          ] as const)();
          continue;
        }
        await run.pick([
          [
            4,
            async () => {
              await answer(false);
            },
          ],
          [1, () => message(ALICE)],
          [1, () => message(BOB)],
          [1, cancel],
        ] as const)();
      }
      // Finish: let everything run, approve what's asked, until nothing is left.
      for (let move = 0; move < 60 && !spun; move += 1) {
        const at = await stop();
        if (at === "ended") break;
        if (at === "spinning") {
          run.find("the session takes steps without writing anything");
          spun = true;
          break;
        }
        if (at === "gate") {
          respond(run.gates[0]!, true);
          continue;
        }
        checkQuiet();
        if (!(await answer(true))) break;
      }
      const view = run.complete;
      if (!spun && activeTurn(view) !== undefined)
        run.find("a turn is still open once nothing is left");
      for (const deliveryId of spun ? [] : run.sent)
        if (view.deliveries[deliveryId]?.status !== "settled")
          run.find(`delivery ${deliveryId} never settled`);
      const warned = warn.mock.calls.filter(
        (args) =>
          String(args[0]).startsWith("[eve:execution.step-decision]") &&
          run.sessions.has(String((args[1] as { sessionId?: string } | undefined)?.sessionId)),
      );
      for (const [, detail] of warned) {
        const { disagreement, position, sessionId } = detail as {
          disagreement: string;
          position: number;
          sessionId: string;
        };
        const where = sessionId === owner.runId ? "the session" : "a child session";
        run.find(
          `${where} decided otherwise than its tables say at line ${position}: ${disagreement}`,
        );
      }
      for (const reason of await stepRetries(startedAt)) run.find(`a step failed: ${reason}`);
    } finally {
      for (const gate of run.gates.splice(0)) gate.release(textStreamResult("Done."));
      await reading.stop();
      await owner.cancel().catch(() => {});
      warn.mockRestore();
    }
  });
  return run.findings;
}

/** Folds every stored line the session writes into the episode, as it arrives, until stopped. */
function readLines(readable: ReadableStream<Uint8Array>, run: Episode): { stop(): Promise<void> } {
  const reader = readable.getReader();
  let stopping = false;
  const reading = read(reader, run).catch((error) => {
    if (!stopping) run.find(`stream reader failed: ${String(error)}`);
  });
  return {
    async stop() {
      stopping = true;
      await reader.cancel().catch(() => {});
      await reading;
    },
  };
}

async function read(reader: ReadableStreamDefaultReader<Uint8Array>, run: Episode): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (text.length === 0) continue;
        const line: unknown = JSON.parse(text);
        if (isStoredLine(line)) run.fold(line);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("sessions driven at random keep what their tables promise at every point they wait", () => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed += 1)
    it(`seed ${seed}`, async () => {
      expect(await drive(seed)).toEqual([]);
    });
});
