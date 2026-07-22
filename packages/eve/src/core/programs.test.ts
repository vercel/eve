import { describe, expect, it } from "vitest";

import { runSession, runTurn } from "#core/index.js";
import { TASK_MODE_WAIT_ERROR_MESSAGE } from "#core/turn-program.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-store.js";
import type { LoopRequest } from "#core/types.js";
import type {
  ChildResults,
  CompletedTurn,
  GenerateInput,
  SessionAdvance,
  SessionBackend,
  SessionState,
  SuspendedTurn,
  TurnHandle,
  TurnOutcome,
  TurnProgramInput,
  TurnStepResult,
} from "#internal/loops/types.js";

type Delivery = Extract<TurnProgramInput["delivery"], { readonly kind: "deliver" }>;

describe("runTurn", () => {
  it("advances through continue steps, checkpointing each, and settles done", async () => {
    const backend = new ScriptedBackend([
      { action: "continue", state: state("s1") },
      {
        action: "done",
        output: "final",
        state: state("s2"),
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1, outputTokens: 2 },
      },
    ]);

    const outcome = await runTurn(backend, turnInput({ mode: "task" }));

    expect(outcome).toMatchObject({ kind: "done", output: "final" });
    expect(outcome.state.durable.sessionId).toBe("s2");
    // Checkpoint fires after the continue step only; terminal state travels
    // in the outcome.
    expect(backend.checkpoints.map((s) => s.durable.sessionId)).toEqual(["s1"]);
    // The first step receives the delivery; continuation steps receive none.
    expect(backend.generateCalls.map((call) => call.input?.kind)).toEqual(["deliver", undefined]);
  });

  it("parks a conversation waiting for public input", async () => {
    const backend = new ScriptedBackend([
      {
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        action: "park",
        state: state("s1"),
      },
    ]);

    await expect(runTurn(backend, turnInput({ mode: "conversation" }))).resolves.toMatchObject({
      kind: "waiting",
    });
  });

  it("rejects an unparkable task-mode wait", async () => {
    const backend = new ScriptedBackend([
      {
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        action: "park",
        state: state("s1"),
      },
    ]);

    await expect(runTurn(backend, turnInput({ mode: "task" }))).rejects.toThrow(
      TASK_MODE_WAIT_ERROR_MESSAGE,
    );
  });

  it.each([
    {
      name: "a pending authorization",
      waiting: { hasPendingAuthorization: true, hasPendingInputBatch: false },
    },
    {
      name: "a pending input batch with requestInput capability",
      waiting: { hasPendingAuthorization: false, hasPendingInputBatch: true },
    },
  ])("parks a task-mode wait for $name", async ({ waiting }) => {
    const backend = new ScriptedBackend([{ ...waiting, action: "park", state: state("s1") }]);

    await expect(
      runTurn(backend, turnInput({ capabilities: { requestInput: true }, mode: "task" })),
    ).resolves.toMatchObject({ kind: "waiting" });
  });

  it("settles an observed cancellation as a cancelled outcome, not a failure", async () => {
    const backend = new ScriptedBackend([{ action: "cancelled", state: state("s1") }]);

    await expect(runTurn(backend, turnInput({ mode: "conversation" }))).resolves.toMatchObject({
      kind: "cancelled",
    });
    expect(backend.checkpoints).toHaveLength(0);
  });

  it("spawns every child before waiting and folds results back in as the next input", async () => {
    const requests: LoopRequest[] = [
      { key: "subagent-call:a:1", kind: "subagent" },
      { key: "subagent-call:b:2", kind: "subagent" },
    ];
    const results: ChildResults = [
      { callId: "call-a", kind: "subagent-result", output: "A", subagentName: "a" },
      { callId: "call-b", kind: "subagent-result", output: "B", subagentName: "b" },
    ];
    const backend = new ScriptedBackend(
      [
        {
          action: "park",
          hasPendingAuthorization: false,
          hasPendingInputBatch: false,
          pendingRuntimeActionKeys: requests.map((request) => request.key),
          state: state("s1"),
        },
        { action: "done", output: "after-children", state: state("s2") },
      ],
      { childResults: results },
    );

    const outcome = await runTurn(backend, turnInput({ mode: "task" }));

    expect(outcome).toMatchObject({ kind: "done", output: "after-children" });
    expect(backend.spawnedRequests).toEqual([requests]);
    expect(backend.spawnOrder).toEqual(["spawn", "wait"]);
    // The folded results arrive as the second generation's input.
    expect(backend.generateCalls[1]?.input).toMatchObject({
      kind: "runtime-action-result",
    });
  });

  it("continues with no input when the child wait observes a cancellation", async () => {
    const backend = new ScriptedBackend(
      [
        {
          action: "park",
          hasPendingAuthorization: false,
          hasPendingInputBatch: false,
          pendingRuntimeActionKeys: ["subagent-call:a:1"],
          state: state("s1"),
        },
        { action: "cancelled", state: state("s2") },
      ],
      { childResults: "cancelled" },
    );

    await expect(runTurn(backend, turnInput({ mode: "conversation" }))).resolves.toMatchObject({
      kind: "cancelled",
    });
    expect(backend.generateCalls[1]?.input).toBeUndefined();
  });

  it("hands each step a monotonically increasing ordinal", async () => {
    const backend = new ScriptedBackend([
      { action: "continue", state: state("s1") },
      { action: "continue", state: state("s2") },
      { action: "done", output: "done", state: state("s3") },
    ]);

    await runTurn(backend, turnInput({ mode: "task" }));

    expect(backend.generateOrdinals).toEqual([0, 1, 2]);
  });
});

describe("runSession", () => {
  it("dispatches a turn per delivery and finishes exactly once on done", async () => {
    const turns: TurnOutcome[] = [
      {
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        kind: "waiting",
        state: state("s1"),
      },
      { kind: "done", output: "bye", state: state("s2") },
    ];
    const backend = new ScriptedSessionBackend({
      deliveries: [delivery("follow-up")],
      turns,
    });

    const outcome = await runSession(backend, {
      capabilities: undefined,
      initialDelivery: delivery("hello"),
      mode: "conversation",
      state: state("s0"),
    });

    expect(outcome).toEqual({ isError: undefined, output: "bye", usage: undefined });
    expect(backend.finished).toEqual([turns[1]]);
    expect(backend.turnDeliveries.map((d) => d.requestId)).toEqual(["hello", "follow-up"]);
    expect(backend.turnOrdinals).toEqual([0, 1]);
    // The waiting turn's state threads into the next turn's input.
    expect(backend.turnStates.map((s) => s.durable.sessionId)).toEqual(["s0", "s1"]);
  });

  it("parks through a cancelled turn and resumes on the next delivery", async () => {
    const cancelled = { kind: "cancelled", state: state("s1") } as const;
    const backend = new ScriptedSessionBackend({
      deliveries: [delivery("after-cancel")],
      turns: [cancelled, { kind: "done", output: "recovered", state: state("s2") }],
    });

    await expect(
      runSession(backend, {
        capabilities: undefined,
        initialDelivery: delivery("hello"),
        mode: "conversation",
        state: state("s0"),
      }),
    ).resolves.toMatchObject({ output: "recovered" });
    expect(backend.parked).toEqual([cancelled]);
  });

  it("returns the backend's terminal outcome when a parked session closes", async () => {
    const backend = new ScriptedSessionBackend({
      advances: [{ kind: "closed", outcome: { output: "closed" } }],
      turns: [
        {
          hasPendingAuthorization: false,
          hasPendingInputBatch: false,
          kind: "waiting",
          state: state("s1"),
        },
      ],
    });

    await expect(
      runSession(backend, {
        capabilities: undefined,
        initialDelivery: delivery("hello"),
        mode: "conversation",
        state: state("s0"),
      }),
    ).resolves.toEqual({ output: "closed" });
    expect(backend.finished).toEqual([]);
  });
});

function state(sessionId: string): SessionState {
  return {
    durable: {
      continuationToken: `token:${sessionId}`,
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
      hasProxyInputRequests: false,
      sessionId,
      version: DURABLE_SESSION_VERSION,
    },
    serializedContext: { sessionId },
  };
}

function delivery(requestId: string): Delivery {
  return { kind: "deliver", payloads: [{ message: requestId }], requestId };
}

function turnInput(input: {
  readonly capabilities?: TurnProgramInput["capabilities"];
  readonly mode: TurnProgramInput["mode"];
}): TurnProgramInput {
  return {
    capabilities: input.capabilities,
    delivery: delivery("initial"),
    mode: input.mode,
    state: state("s0"),
  };
}

class ScriptedBackend {
  readonly checkpoints: SessionState[] = [];
  readonly generateCalls: GenerateInput[] = [];
  readonly generateOrdinals: number[] = [];
  readonly spawnedRequests: (readonly LoopRequest[])[] = [];
  readonly spawnOrder: string[] = [];
  readonly #childResults: ChildResults;
  readonly #script: TurnStepResult[];

  constructor(
    script: readonly TurnStepResult[],
    options: {
      readonly childResults?: ChildResults;
    } = {},
  ) {
    this.#childResults = options.childResults ?? [];
    this.#script = [...script];
  }

  async checkpoint(state: SessionState): Promise<void> {
    this.checkpoints.push(state);
  }

  async generate(input: GenerateInput): Promise<TurnStepResult> {
    this.generateCalls.push(input);
    this.generateOrdinals.push(input.stepOrdinal);
    const scripted = this.#script.shift();
    if (scripted === undefined) throw new Error("Scripted backend ran out of generations.");
    return scripted;
  }

  async spawnChildren(state: SessionState, requests: readonly LoopRequest[]) {
    this.spawnedRequests.push(requests);
    this.spawnOrder.push("spawn");
    return {
      handle: {
        wait: async () => {
          this.spawnOrder.push("wait");
          return { results: this.#childResults, state };
        },
      },
      state,
    };
  }
}

class ScriptedSessionBackend implements SessionBackend {
  readonly finished: CompletedTurn[] = [];
  readonly parked: SuspendedTurn[] = [];
  readonly turnDeliveries: Delivery[] = [];
  readonly turnOrdinals: number[] = [];
  readonly turnStates: SessionState[] = [];
  readonly #advances: SessionAdvance[];
  readonly #deliveries: Delivery[];
  readonly #turns: TurnOutcome[];

  constructor(options: {
    readonly advances?: readonly SessionAdvance[];
    readonly deliveries?: readonly Delivery[];
    readonly turns: readonly TurnOutcome[];
  }) {
    this.#advances = [...(options.advances ?? [])];
    this.#deliveries = [...(options.deliveries ?? [])];
    this.#turns = [...options.turns];
  }

  async finish(turn: CompletedTurn): Promise<void> {
    this.finished.push(turn);
  }

  async park(turn: SuspendedTurn): Promise<SessionAdvance> {
    this.parked.push(turn);
    const scripted = this.#advances.shift();
    if (scripted !== undefined) return scripted;
    const next = this.#deliveries.shift();
    if (next === undefined) throw new Error("Scripted backend ran out of deliveries.");
    return { delivery: next, kind: "delivery", state: turn.state };
  }

  spawnTurn(input: TurnProgramInput, turnOrdinal: number): TurnHandle {
    this.turnDeliveries.push(input.delivery as Delivery);
    this.turnOrdinals.push(turnOrdinal);
    this.turnStates.push(input.state);
    return {
      wait: async () => {
        const next = this.#turns.shift();
        if (next === undefined) throw new Error("Scripted backend ran out of turns.");
        return next;
      },
    };
  }
}
