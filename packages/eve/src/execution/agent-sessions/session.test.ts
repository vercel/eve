import { workflowRunHost } from "#execution/tools/workflow/workflow-run-host.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface PendingDelivery {
  readonly input: { readonly auth: SessionAuth; readonly replyTo: string };
  readonly admit: () => void;
}

const mocks = vi.hoisted(() => {
  const hooks = new Map<string, { push: (value: unknown) => void }>();
  let tokens = 0;
  return {
    hooks,
    admitted: [] as string[],
    pending: [] as PendingDelivery[],
    createRemoteReplyToken: vi.fn(async () => {
      const index = tokens++;
      if (index % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
      return `reply-${String(index)}`;
    }),
    createHook: (options?: { readonly token?: string }) => {
      const token = options?.token ?? `reply-${String(tokens++)}`;
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
  createRemoteReplyTokenStep: mocks.createRemoteReplyToken,
  cancelAgentSessionTurnStep: vi.fn(async () => {}),
  endAgentSessionsStep: vi.fn(async () => {}),
  stopLateAgentSessionStep: vi.fn(async () => {}),
  openAgentSessionStep: vi.fn(async (input: { readonly replyTo: string }) => {
    mocks.admitted.push(input.replyTo);
    return {
      address: { kind: "local", name: "reviewer", nodeId: "reviewer", sessionId: "child" },
      deliveryId: `delivery-${input.replyTo}`,
    };
  }),
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

let remoteAgents: readonly string[] | undefined = [];

function agentContext(callId: string): AgentSessionContext {
  return {
    agents: { reviewer: { description: "Review the plan." } },
    capabilities: { requestInput: true },
    bundle: { source: { kind: "development" } },
    dynamicSelections: {},
    ...(remoteAgents !== undefined && { remoteAgents }),
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

function serveRun() {
  const sent: WorkflowToolRunMessage[] = [];
  let current = { auth: auth("alice"), callId: "call-1" };
  const run: WorkflowToolRunContext = {
    get agentContext() {
      return agentContext(current.callId);
    },
    asks: new WorkflowToolRunAsks("run"),
    host: workflowRunHost,
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

async function landNewestFirst(): Promise<void> {
  await vi.waitFor(() => expect(mocks.pending.length).toBeGreaterThan(0));
  while (mocks.pending.length > 0) {
    mocks.pending.pop()?.admit();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mocks.admitted.length = 0;
  mocks.pending.length = 0;
  mocks.createRemoteReplyToken.mockClear();
  mocks.reset();
  remoteAgents = [];
});

describe.each([
  { agent: "a local agent", remote: false },
  { agent: "a remote agent", remote: true },
])("messages to $agent", ({ remote }) => {
  beforeEach(() => {
    remoteAgents = remote ? ["reviewer"] : [];
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
    expect(mocks.admitted).toEqual(["reply-0", "reply-1", "reply-2"]);
    expect(mocks.createRemoteReplyToken).toHaveBeenCalledTimes(remote ? 3 : 0);
  });

  it("delivers and records each message for the call and auth it was sent with", async () => {
    const { sessions, sent, serve } = serveRun();
    const reviewer = sessions.open("reviewer");
    await reviewer.send("Alice opens the review.");
    const alices = reviewer.send("Alice adds a checklist.");
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
});

it("keeps naming reply hooks by the step once a call found the agent remote", async () => {
  remoteAgents = ["reviewer"];
  const { sessions, serve } = serveRun();
  const reviewer = sessions.open("reviewer");
  await reviewer.send("Alice opens the review.");
  remoteAgents = [];
  serve("call-2", "bob");
  const bobs = reviewer.send("Bob adds a rollout note.");
  await landNewestFirst();
  await bobs;

  expect(mocks.createRemoteReplyToken).toHaveBeenCalledTimes(2);
});

it("names the reply hook by the step for a call that doesn't say which agents are remote", async () => {
  remoteAgents = undefined;
  const { sessions } = serveRun();

  await sessions.open("reviewer").send("Alice opens the review.");

  expect(mocks.createRemoteReplyToken).toHaveBeenCalledTimes(1);
});

it("fails only the message whose remote reply hook could not be named", async () => {
  remoteAgents = ["reviewer"];
  const { sessions } = serveRun();
  const reviewer = sessions.open("reviewer");
  const seed = await reviewer.send("seed");
  mocks.createRemoteReplyToken.mockRejectedValueOnce(new Error("The naming step failed."));
  const left = reviewer.send("left");
  const right = reviewer.send("right");

  await expect(left).rejects.toThrow("The naming step failed.");
  await landNewestFirst();
  const sent = await right;
  endChildTurn("reviewed both");
  await expect(Promise.all([seed.result(), sent.result()])).resolves.toMatchObject([
    { reply: "reviewed both", status: "completed" },
    { reply: "reviewed both", status: "completed" },
  ]);
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
