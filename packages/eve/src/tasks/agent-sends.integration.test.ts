import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, RuntimeActionResultHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { taskLifecycleViolations } from "#internal/testing/task-lifecycle.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { taskEvents } from "#tasks/events.js";
import { applyTaskReport, startAgentTasks } from "#tasks/owner.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderSendReceipt, renderUnconfirmedSendReceipt } from "#tasks/render.js";
import { readPendingTaskResults } from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";

// Sends to a working agent, run against the agent's real input queue: it
// admits each operation once and counts the steering messages it admitted
// for the call it answers, which is the count the owner maps onto its sends.
// Only the transport between them fails, as a timeout would.

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({ prepareActionDispatch: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createWorkflowRuntime: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const LOCAL_CHILD = {
  continuationToken: "child-token",
  kind: "local",
  sessionId: "child",
} as const;
const bundle = {
  compiledArtifactsSource: {},
  subagentRegistry: {
    subagentsByName: new Map([
      [
        "research",
        {
          definition: {
            description: "Research",
            kind: "subagent",
            name: "research",
            nodeId: "subagents/research",
          },
        },
      ],
    ]),
    subagentsByNodeId: new Map([
      ["subagents/research", { definition: { description: "Research", kind: "subagent" } }],
    ]),
  },
  turnAgent: {},
};

/** The fields of the owner's send command the writer's inbox reads. */
type SendCommand = Pick<DeliverHookPayload, "caller" | "operationId" | "turnPolicy"> & {
  readonly payload: DeliverHookPayload["payloads"][number];
};

/** The writer's session: its input queue, and how the next deliveries to it fail. */
const writer = {
  /** Deliveries that reach the queue and then time out before the owner hears back. */
  lostAnswers: 0,
  /** Deliveries that time out before they reach the queue. */
  lostRequests: 0,
  queue: new SessionInputQueue(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  writer.lostAnswers = 0;
  writer.lostRequests = 0;
  writer.queue = new SessionInputQueue();
  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle as never);
  vi.mocked(deserializeContext).mockResolvedValue(ctx);
  vi.mocked(prepareActionDispatch).mockImplementation(
    async (input) =>
      ({
        auth: null,
        bundle,
        creator: { auth: null },
        fanoutSize: 1,
        initiatorAuth: null,
        plan: input.plan({
          bundle: bundle as never,
          ctx: input.ctx,
          requests: input.batch.requests,
          session: runtimeSession(input.durableSession),
        }),
        sandboxSessionId: "owner",
        session: runtimeSession(input.durableSession),
      }) as never,
  );
  vi.mocked(createWorkflowRuntime).mockReturnValue({
    dispatchSession: async ({ command }: { command: SendCommand }) => {
      if (writer.lostRequests > 0) {
        writer.lostRequests -= 1;
        throw new Error("The request timed out.");
      }
      writer.queue.enqueueDelivery({
        caller: command.caller,
        kind: "deliver",
        operationId: command.operationId,
        payloads: [command.payload],
        turnPolicy: command.turnPolicy,
      });
      if (writer.lostAnswers > 0) {
        writer.lostAnswers -= 1;
        throw new Error("The request timed out.");
      }
      return { status: "accepted" };
    },
  } as never);
});

function runtimeSession(durable: ReturnType<typeof readDurableSession>) {
  return {
    ...durable,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
}

/** Alice's session, whose writer agent is working on her first request. */
function owner() {
  const working = createTaskRecord({
    callId: "call-0",
    child: LOCAL_CHILD,
    mode: "detached",
    turnId: "turn-1",
  });
  let state: DurableSessionState = createDurableSessionState({
    session: setHarnessEmissionState(
      {
        agent: { dynamicModel: true, system: "", tools: [] },
        compaction: { recentWindowSize: 5, threshold: 10_000 },
        continuationToken: "owner-token",
        history: [],
        sessionId: "owner",
        state: taskTableState([working]),
      },
      { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
    ),
  });
  const events: UnstampedMessageStreamEvent[] = taskEvents(
    [{ kind: "started", record: working }],
    "owner",
  );
  /** The writer's answer to the call it works on, counting the messages it read so far. */
  const compose = (output: string): RuntimeActionResultHookPayload => ({
    kind: "runtime-action-result",
    results: [
      {
        callId: "call-0",
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output },
          usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
        },
        output,
        steers: writer.queue.takeSteerCount("call-0"),
        subagentName: "research",
      } as never,
    ],
  });
  /** The owner applies an answer that reached its inbox. */
  const apply = async (payload: RuntimeActionResultHookPayload): Promise<void> => {
    const update = await applyTaskReport({
      now: NOW,
      payload,
      serializedContext: {},
      sessionState: state,
    });
    state = update.sessionState;
    events.push(...update.events);
  };
  return {
    /** The writer answers, and its answer reaches the owner at once. */
    answer: async (output: string) => await apply(compose(output)),
    apply,
    compose,
    events,
    record: (): TaskRecord => getTaskTable(readDurableSession(state)).records[0]!,
    results: () => readPendingTaskResults(readDurableSession(state).state),
    /** A model call to the writer with its taskId. */
    async send(callId: string, message: string): Promise<RuntimeToolResultActionResult> {
      const update = await startAgentTasks({
        callbackBaseUrl: "https://owner.example",
        calls: [
          {
            callId,
            input: { message, target: "research", taskId: working.id },
            toolName: "research",
          },
        ],
        now: NOW,
        serializedContext: {},
        sessionState: state,
      });
      state = update.sessionState;
      events.push(...update.events);
      return update.results[0]!;
    },
    working,
  };
}

describe("sends to a working agent over a transport that times out", () => {
  it("gives every send a result when a timeout hides that the agent took one", async () => {
    const alice = owner();
    // The writer takes the correction, but the owner's request times out; the retry
    // carries the same key, which the writer admits once.
    writer.lostAnswers = 1;
    expect(await alice.send("call-x", "Cover pricing.")).toMatchObject({
      modelOutput: renderSendReceipt(alice.working, false),
    });
    // Alice asks for the same thing again.
    await alice.send("call-y", "Cover pricing, please.");
    expect(alice.record().sends?.map((send) => send.callId)).toEqual(["call-x", "call-y"]);

    // The writer answers having read both; Alice's next change arrives while that answer
    // is on its way, so the writer runs it as its next turn.
    const answer = alice.compose("Draft with pricing.");
    await alice.send("call-z", "Add the launch date.");
    await alice.apply(answer);
    expect(alice.record()).toMatchObject({ callId: "call-z", generation: 2, status: "working" });

    await alice.answer("Draft with pricing and the date.");

    expect(alice.record()).toMatchObject({ generation: 2, status: "completed" });
    expect(alice.record().sends).toBeUndefined();
    expect(alice.results().map((result) => [result.generation, result.outcome])).toEqual([
      [1, { output: "Draft with pricing.", status: "completed" }],
      [2, { output: "Draft with pricing and the date.", status: "completed" }],
    ]);
    expect(taskLifecycleViolations(alice.events)).toEqual([]);
  });

  it("keeps a send every attempt left in doubt until the agent's answer settles it", async () => {
    const alice = owner();
    // Each attempt reaches the writer, which admits the message once, and each times out.
    writer.lostAnswers = 3;
    expect(await alice.send("call-x", "Cover pricing.")).toMatchObject({
      modelOutput: renderUnconfirmedSendReceipt(alice.working),
    });
    expect(await alice.send("call-y", "Cover pricing, please.")).toMatchObject({
      output: { code: "TASK_BUSY" },
    });

    await alice.answer("Draft with pricing.");

    expect(alice.record()).toMatchObject({ generation: 1, status: "completed" });
    expect(alice.record().sends).toBeUndefined();
    expect(alice.results()).toHaveLength(1);
    expect(taskLifecycleViolations(alice.events)).toEqual([]);
  });

  it("fails a send every attempt left in doubt when the agent never got it", async () => {
    const alice = owner();
    writer.lostRequests = 3;
    await alice.send("call-x", "Cover pricing.");

    await alice.answer("Draft without pricing.");

    expect(alice.results().map((result) => [result.generation, result.outcome.status])).toEqual([
      [1, "completed"],
      [2, "failed"],
    ]);
    expect(alice.record()).toMatchObject({ callId: "call-x", generation: 2, status: "failed" });
    expect(taskLifecycleViolations(alice.events)).toEqual([]);
  });
});
