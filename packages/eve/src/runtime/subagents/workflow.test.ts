import { expect, it, vi } from "vitest";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { startServeBody } from "#execution/tools/workflow/serve.js";
import type { AgentTurnResult } from "#shared/agent-turn-outcome.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The agent's side of the task: the messages it read and the turns it owes a reply. */
const agent = vi.hoisted(() => ({
  delivered: [] as WorkflowToolRunMessage[],
  read: [] as string[],
  turns: [] as Array<(payload: RuntimeActionResultHookPayload) => void>,
}));

vi.mock("#execution/workflow-registry.js", async () => {
  const { agentToolServeWorkflow } = await import("#runtime/subagents/workflow.js");
  return { readRegisteredWorkflow: () => agentToolServeWorkflow };
});
vi.mock("#execution/agent-sessions/steps.js", () => ({
  cancelAgentSessionTurnStep: async () => {},
  endAgentSessionsStep: async () => {},
  openAgentSessionStep: async ({ message }: { readonly message: string }) => {
    agent.read.push(message);
    return { kind: "local", name: "reviewer", nodeId: "reviewer", sessionId: "reviewer-session" };
  },
  sendAgentSessionMessageStep: async ({ message }: { readonly message: string }) => {
    agent.read.push(message);
  },
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  // Each message's reply hook; the agent reports the turn that read it through it.
  createHook: () => {
    let report: (payload: RuntimeActionResultHookPayload) => void = () => {};
    const reported = new Promise<RuntimeActionResultHookPayload>((resolve) => {
      report = resolve;
    });
    agent.turns.push(report);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: await reported }),
      }),
      dispose: async () => {},
      token: `agent-turn-${String(agent.turns.length)}`,
    };
  },
}));

const agentContext = {
  agents: {},
  capabilities: { requestInput: false },
  parent: {
    callId: "call-1",
    rootSessionId: "session",
    sessionId: "session",
    turn: { id: "turn", sequence: 1 },
  },
} as AgentSessionContext;

const alice: SessionAuth = {
  current: { attributes: {}, authenticator: "test", principalId: "alice", principalType: "user" },
  initiator: null,
};

const input: WorkflowBodyInput = {
  agentContext,
  callId: "call-1",
  entry: { entryPoint: "serve", taskId: "reviewer-7k2m9q" },
  input: { message: "Review the release plan." },
  hookToken: "control",
  owner: {
    send: async (message) => {
      agent.delivered.push(message);
    },
    sent: 0,
  },
  runId: "run",
  session: { auth: alice, id: "session", turn: { id: "turn", sequence: 1 } },
  stepIndex: 0,
  toolName: "reviewer",
  workflowId: "workflow//eve//agentToolServeWorkflow",
};

function usage(inputTokens: number, outputTokens: number, costUsd?: number): TokenUsage {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, inputTokens, outputTokens };
}

function turnEnded(
  result: AgentTurnResult,
  usageDelta: TokenUsage = usage(0, 0),
): RuntimeActionResultHookPayload {
  return {
    kind: "runtime-action-result",
    results: [
      {
        callId: "child-call",
        kind: "subagent-result",
        origin: "child",
        outcome: { kind: "parked", result, usageDelta },
        output: result.kind === "succeeded" ? result.output : "",
        subagentName: "reviewer",
      },
    ],
  };
}

/** Lets every pending step and hook delivery settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function replies(): Array<{ readonly callId: string; readonly output: unknown }> {
  return agent.delivered.flatMap((message) =>
    message.kind === "reply"
      ? message.callIds.map((callId) => ({ callId, output: message.output }))
      : [],
  );
}

/** Alice asks the reviewer for a review; the reviewer has read her message. */
async function startReview(): Promise<ReturnType<typeof startServeBody>> {
  agent.delivered.length = 0;
  agent.read.length = 0;
  agent.turns.length = 0;
  const started = startServeBody(input);
  await settle();
  return started;
}

/** Alice's next message: check the plan against the Friday freeze. */
const fridayCheck = {
  call: {
    agentContext,
    auth: alice,
    callId: "call-2",
    input: { message: "Check it against the Friday freeze." },
    sequence: 1,
    stepIndex: 1,
    turnId: "turn",
  },
  kind: "call",
} as const;

/** The messages that carried the task's usage to its session, in order. */
function usageMessages(): unknown[] {
  return agent.delivered.flatMap((message): unknown[] => {
    if (message.kind === "reply") return [{ reply: message.callIds, usage: message.usage }];
    return message.kind === "usage" ? [{ usage: message.usage }] : [];
  });
}

/**
 * Alice asks the reviewer for a review, and her next message reaches the task
 * `offset` microtasks after the reviewer's first turn ends. If `cancelled`,
 * she cancelled the review first, so the turn ends cancelled.
 */
async function sendAsTheTurnEnds(offset: number, { cancelled }: { readonly cancelled: boolean }) {
  const started = await startReview();
  if (cancelled) started.control.apply({ kind: "cancel", reason: "Alice cancelled the review." });
  agent.turns[0]?.(
    turnEnded(
      cancelled ? { kind: "cancelled" } : { kind: "succeeded", output: "The plan looks ready." },
    ),
  );
  for (let tick = 0; tick < offset; tick += 1) await Promise.resolve();
  const repliedFirst = replies().length > 0;
  started.control.apply(fridayCheck);
  await settle();
  agent.turns[1]?.(turnEnded({ kind: "succeeded", output: "The plan misses the Friday freeze." }));
  await settle();
  started.control.apply({ kind: "end", reason: "The session ended." });
  await started.outcome;
  return { read: [...agent.read], repliedFirst, replies: replies() };
}

it("forwards a message that reaches the task at any point as the agent's turn ends", async () => {
  // From joining the running turn to arriving after its reply, every arrival
  // point is covered: the sweep stops once the first reply precedes the
  // message. A cancelled turn ends through the same steps minus the reply, so
  // the same sweep covers it.
  for (let offset = 0; ; offset += 1) {
    const answered = await sendAsTheTurnEnds(offset, { cancelled: false });
    const cancelled = await sendAsTheTurnEnds(offset, { cancelled: true });

    for (const [firstTurn, run, firstCallReplies] of [
      ["answered", answered, 1],
      ["cancelled", cancelled, 0],
    ] as const) {
      const arrival = `${firstTurn} first turn, message ${String(offset)} microtasks after it ended`;
      expect(run.read, arrival).toEqual([
        "Review the release plan.",
        "Check it against the Friday freeze.",
      ]);
      // The turn that read the message answers it. The first call gets one
      // reply, unless cancelled: from its own turn or the one the message
      // joined or started.
      expect(
        run.replies.filter(({ callId }) => callId === "call-2"),
        arrival,
      ).toEqual([{ callId: "call-2", output: "The plan misses the Friday freeze." }]);
      expect(
        run.replies.filter(({ callId }) => callId === "call-1"),
        arrival,
      ).toHaveLength(firstCallReplies);
    }

    if (answered.repliedFirst) break;
    expect(offset, "the first reply never came before the message").toBeLessThan(100);
  }
});

it("fails the task with the reason the agent's turn failed and how to retry", async () => {
  const started = await startReview();
  agent.turns[0]?.(
    turnEnded({
      error: {
        code: "SUBAGENT_EXECUTION_FAILED",
        message: "The model provider rejected the request.",
      },
      kind: "failed",
    }),
  );

  await expect(started.outcome).resolves.toMatchObject({
    error: {
      message:
        "The agent's turn failed: The model provider rejected the request.\nThis task has ended; to retry, call reviewer without taskId.",
    },
    status: "failed",
  });
});

it("carries the task's running usage on each reply", async () => {
  const started = await startReview();
  agent.turns[0]?.(
    turnEnded({ kind: "succeeded", output: "The plan looks ready." }, usage(1_000, 100, 0.25)),
  );
  await settle();
  started.control.apply(fridayCheck);
  await settle();
  agent.turns[1]?.(
    turnEnded(
      { kind: "succeeded", output: "The plan misses the Friday freeze." },
      usage(500, 50, 0.5),
    ),
  );
  await settle();
  started.control.apply({ kind: "end", reason: "The session ended." });
  await started.outcome;

  expect(usageMessages()).toEqual([
    { reply: ["call-1"], usage: usage(1_000, 100, 0.25) },
    { reply: ["call-2"], usage: usage(1_500, 150, 0.75) },
  ]);
});

it("counts a turn that messages joined once, on the reply that settles them all", async () => {
  const started = await startReview();
  started.control.apply(fridayCheck);
  await settle();
  // The turn reports to the latest message it read, which settles both calls.
  agent.turns[1]?.(
    turnEnded({ kind: "succeeded", output: "Ready, and clear of the freeze." }, usage(800, 80)),
  );
  await settle();
  started.control.apply({ kind: "end", reason: "The session ended." });
  await started.outcome;

  expect(usageMessages()).toEqual([{ reply: ["call-1", "call-2"], usage: usage(800, 80) }]);
});

it("sends a cancelled turn's usage on its own, since no reply carries it", async () => {
  const started = await startReview();
  started.control.apply({ kind: "cancel", reason: "Alice cancelled the review." });
  agent.turns[0]?.(turnEnded({ kind: "cancelled" }, usage(400, 40)));
  await settle();
  started.control.apply(fridayCheck);
  await settle();
  agent.turns[1]?.(
    turnEnded({ kind: "succeeded", output: "The plan misses the Friday freeze." }, usage(100, 10)),
  );
  await settle();
  started.control.apply({ kind: "end", reason: "The session ended." });
  await started.outcome;

  expect(usageMessages()).toEqual([
    { usage: usage(400, 40) },
    { reply: ["call-2"], usage: usage(500, 50) },
  ]);
});

it("sends no usage once the session ended, since no one would count it", async () => {
  const started = await startReview();
  started.control.apply({ kind: "cancel", reason: "Alice cancelled the review." });
  started.control.apply({ kind: "end", reason: "The session ended." });
  agent.turns[0]?.(turnEnded({ kind: "cancelled" }, usage(400, 40)));
  await settle();
  await started.outcome;

  expect(usageMessages()).toEqual([]);
});
