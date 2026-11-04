import { beforeEach, expect, it, vi } from "vitest";

import type { RuntimeActionResultHookPayload } from "#channel/types.js";
import type { SessionAuth } from "#context/keys.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally } from "#execution/agent-sessions/usage.js";
import { WorkflowToolRunAsks, type WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";

/** A delivery step the test lets land (be admitted by the child) when it chooses. */
interface PendingDelivery {
  readonly input: { readonly auth: SessionAuth; readonly replyTo: string };
  readonly admit: () => void;
}

const mocks = vi.hoisted(() => {
  /** Reply hooks by token; the child resumes one when its turn ends. */
  const hooks = new Map<string, { push: (value: unknown) => void }>();
  let tokens = 0;
  return {
    hooks,
    /** Reply tokens in the order the child admitted their messages. */
    admitted: [] as string[],
    /** Delivery steps that have not landed yet, oldest first. */
    pending: [] as PendingDelivery[],
    createHook: () => {
      const token = `reply-${String(tokens++)}`;
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      let disposed = false;
      hooks.set(token, {
        push: (value) => {
          queue.push(value);
          wake?.();
        },
      });
      return {
        token,
        dispose: () => {
          disposed = true;
          wake?.();
        },
        async *[Symbol.asyncIterator]() {
          while (!disposed) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => (wake = resolve));
          }
        },
      };
    },
    reset: () => {
      hooks.clear();
      tokens = 0;
    },
  };
});

vi.mock("#compiled/@workflow/core/index.js", () => ({ createHook: mocks.createHook }));
vi.mock("#execution/agent-sessions/requests.js", () => ({
  forwardAgentSessionRequest: vi.fn(async () => {}),
}));
vi.mock("#execution/agent-sessions/steps.js", () => ({
  cancelAgentSessionTurnStep: vi.fn(async () => {}),
  endAgentSessionsStep: vi.fn(async () => {}),
  stopLateAgentSessionStep: vi.fn(async () => {}),
  // The opening message is admitted as the session opens.
  openAgentSessionStep: vi.fn(async (input: { readonly replyTo: string }) => {
    mocks.admitted.push(input.replyTo);
    return {
      address: { kind: "local", name: "reviewer", nodeId: "reviewer", sessionId: "child" },
      deliveryId: `delivery-${input.replyTo}`,
    };
  }),
  // A later message is admitted only when its step lands, which the test controls.
  sendAgentSessionMessageStep: vi.fn(
    (input: { readonly auth: SessionAuth; readonly replyTo: string }) =>
      new Promise((resolve) => {
        mocks.pending.push({
          input,
          admit: () => {
            mocks.admitted.push(input.replyTo);
            resolve({ deliveryId: `delivery-${input.replyTo}`, sessionId: "child" });
          },
        });
      }),
  ),
}));

function auth(principalId: string): SessionAuth {
  return {
    current: { attributes: {}, authenticator: "test", principalId, principalType: "user" },
    initiator: null,
  };
}

function agentContext(callId: string): AgentSessionContext {
  return {
    agents: { reviewer: { description: "Review the plan." } },
    capabilities: { requestInput: true },
    bundle: { source: { kind: "development" } },
    dynamicSelections: {},
    sandbox: { sessionId: "session" },
    trace: { originAudience: "unknown" },
    parent: {
      callId,
      rootSessionId: "session",
      sessionId: "session",
      turn: { id: `turn-${callId}`, sequence: 1 },
    },
  };
}

/** A serve run whose `auth`, `from`, and `agentContext` follow the call it serves now. */
function serveRun() {
  const sent: WorkflowToolRunMessage[] = [];
  let current = { auth: auth("alice"), callId: "call-1" };
  const run: WorkflowToolRunContext = {
    get agentContext() {
      return agentContext(current.callId);
    },
    asks: new WorkflowToolRunAsks("run"),
    get auth() {
      return current.auth;
    },
    control: "control",
    get from(): WorkflowToolRunRef {
      return {
        callId: current.callId,
        input: {},
        runId: "run",
        sequence: 1,
        stepIndex: 0,
        toolName: "review",
        turnId: `turn-${current.callId}`,
      };
    },
    owner: {
      send: async (message: WorkflowToolRunMessage) => {
        sent.push(message);
      },
      sent: 0,
    },
  };
  const usage = createRunUsageTally();
  return {
    sessions: createAgentSessions(run, usage),
    sent,
    serve: (callId: string, principalId: string) => {
      current = { auth: auth(principalId), callId };
    },
  };
}

/** The child ends its turn, which read every admitted message, replying to the last it read. */
function endChildTurn(output: string): void {
  const latest = mocks.admitted.at(-1);
  if (latest === undefined) throw new Error("The child admitted no message.");
  const payload: RuntimeActionResultHookPayload = {
    kind: "runtime-action-result",
    results: [
      {
        callId: "call-1",
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output },
          usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1, outputTokens: 1 },
        },
        output,
        subagentName: "reviewer",
      },
    ],
  } as RuntimeActionResultHookPayload;
  mocks.hooks.get(latest)?.push(payload);
}

/** Lands the newest pending delivery first, as asynchronous steps may, until none remain. */
async function landNewestFirst(): Promise<void> {
  await vi.waitFor(() => expect(mocks.pending.length).toBeGreaterThan(0));
  while (mocks.pending.length > 0) {
    mocks.pending.pop()?.admit();
    // Let a queued delivery start before deciding which pending step lands next.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mocks.admitted.length = 0;
  mocks.pending.length = 0;
  mocks.reset();
});

it("settles every message a turn read when concurrent deliveries could land out of order", async () => {
  const { sessions } = serveRun();
  const reviewer = sessions.open("reviewer");
  const seed = await reviewer.send("seed");
  const sends = Promise.all([reviewer.send("left"), reviewer.send("right")]);
  await landNewestFirst();
  const [left, right] = await sends;

  endChildTurn("reviewed all three");
  const settled = await Promise.race([
    Promise.all([seed.result(), left.result(), right.result()]),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 500)),
  ]);
  expect(settled).not.toBe("unsettled");
  expect(settled).toMatchObject([
    { reply: "reviewed all three", status: "completed" },
    { reply: "reviewed all three", status: "completed" },
    { reply: "reviewed all three", status: "completed" },
  ]);
  // The child admitted the messages in the order they were sent.
  expect(mocks.admitted).toEqual(["reply-0", "reply-1", "reply-2"]);
});

it("leaves a message the child admitted after the turn ended pending for the next turn", async () => {
  const { sessions } = serveRun();
  const reviewer = sessions.open("reviewer");
  const seed = await reviewer.send("seed");
  endChildTurn("first turn");
  await expect(seed.result()).resolves.toMatchObject({ reply: "first turn" });

  const later = reviewer.send("later");
  await landNewestFirst();
  const pending = await later;
  let settled = false;
  void pending.result().then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  endChildTurn("second turn");
  await expect(pending.result()).resolves.toMatchObject({ reply: "second turn" });
});

it("delivers and records each message for the call and auth it was sent with", async () => {
  const { sessions, sent, serve } = serveRun();
  const reviewer = sessions.open("reviewer");
  await reviewer.send("Alice opens the review.");
  const alices = reviewer.send("Alice adds a checklist.");
  // The task now serves Bob's call before Alice's queued message is delivered.
  serve("call-2", "bob");
  const bobs = reviewer.send("Bob adds a rollout note.");
  await landNewestFirst();
  await Promise.all([alices, bobs]);

  const { sendAgentSessionMessageStep } = await import("#execution/agent-sessions/steps.js");
  expect(
    vi
      .mocked(sendAgentSessionMessageStep)
      .mock.calls.map(([input]) => [input.message, input.auth.current?.principalId]),
  ).toEqual([
    ["Alice adds a checklist.", "alice"],
    ["Bob adds a rollout note.", "bob"],
  ]);
  expect(
    sent.flatMap((message) =>
      message.kind === "agent-sent" ? [[message.deliveryId, message.from.callId]] : [],
    ),
  ).toEqual([
    ["delivery-reply-0", "call-1"],
    ["delivery-reply-1", "call-1"],
    ["delivery-reply-2", "call-2"],
  ]);
});
