import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachChannelActivityPresenter } from "#channel/activity-presenter.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { projectTaskCards } from "#channel/task-card.js";
import { ContextContainer } from "#context/container.js";
import { ActivityObserverKey, ScheduleIdKey } from "#context/keys.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { projectSessionActivity } from "#execution/session-activity-projection.js";
import { createTask, writeTaskTable } from "#execution/tasks/table.js";
import {
  observePlanActivity,
  observeTaskActivity,
  type ObservedDispatch,
} from "#execution/activity-collector-start.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import {
  createActionsRequestedEvent,
  createTaskStartedEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  context: undefined as ContextContainer | undefined,
  startWorkflow: vi.fn(),
  submitted: [] as ActivityEventV1[][],
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: async () => mocks.context,
  serializeContext: (ctx: ContextContainer) => ({
    [ActivityObserverKey.name]: ctx.get(ActivityObserverKey),
  }),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: () => ({ limits: { sessionTimeoutMs: 60_000 } }),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  activityCollectorWorkflowReference: { workflowId: "collector" },
  startWorkflowOnCurrentDeployment: mocks.startWorkflow,
}));
vi.mock("#execution/submit-activity.js", () => ({
  submitActivity: async (input: { readonly events: ActivityEventV1[] }) => {
    mocks.submitted.push(input.events);
  },
}));

const TURN_ID = "turn_1";

/** A root turn's dispatch step for a deploy tool task and a researcher agent task. */
function dispatchOfTwoTasks(): {
  readonly prepared: ObservedDispatch;
  readonly taskIds: { readonly deploy: string; readonly researcher: string };
} {
  const adapter: ChannelAdapter = { kind: "slack", state: {} };
  attachChannelActivityPresenter(adapter, { destination: () => ({}), render: vi.fn() });
  const deploy = createTask(
    { tasks: [] },
    {
      callId: "call_deploy",
      kind: "tool",
      name: "deploy",
      resumable: false,
      turnId: TURN_ID,
    },
  );
  const researcher = createTask(deploy.table, {
    callId: "call_research",
    kind: "agent",
    name: "researcher",
    resumable: true,
    turnId: TURN_ID,
  });
  const root: ObservedDispatch["session"] = {
    agent: {
      tools: [
        {
          description: "Deploy a service.",
          inputSchema: {},
          label: { start: (input) => `Deploy ${String((input as { service: string }).service)}` },
          name: "deploy",
        },
      ],
    },
    rootSessionId: undefined,
    sessionId: "session_root",
    state: undefined,
  };
  const session = writeTaskTable(root, researcher.table);
  const prepared: ObservedDispatch = {
    activityObserver: undefined,
    adapter,
    batch: { event: { sequence: 1, stepIndex: 0, turnId: TURN_ID }, requests: [] },
    plan: [
      {
        callId: "call_deploy",
        entry: { entryPoint: "task", taskId: deploy.taskId },
        input: { service: "storefront" },
        kind: "workflow-task",
        toolName: "deploy",
        workflowId: "deploy",
      },
      {
        callId: "call_research",
        entry: { entryPoint: "serve", taskId: researcher.taskId },
        input: { message: "Find the incidents behind the checkout spike" },
        kind: "workflow-task",
        toolName: "researcher",
        workflowId: "researcher",
      },
    ],
    serializedContext: {},
    session,
  };
  return { prepared, taskIds: { deploy: deploy.taskId, researcher: researcher.taskId } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitted = [];
  mocks.context = new ContextContainer();
  mocks.context.set(BundleKey, { resolvedAgent: {} } as never);
  mocks.startWorkflow.mockResolvedValue({ runId: "collector-run" });
});

describe("observeTaskActivity", () => {
  it("starts the collector on a root turn's first tasks and seeds it with those calls", async () => {
    const { prepared, taskIds } = dispatchOfTwoTasks();

    const observed = await observeTaskActivity(prepared);

    expect(mocks.startWorkflow).toHaveBeenCalledOnce();
    expect(observed.activityObserver?.sink.url).toMatch(/\/eve\/v1\/activity\/[\w-]{43}$/);
    expect(observed.serializedContext[ActivityObserverKey.name]).toEqual({
      sink: observed.activityObserver?.sink,
    });

    // The session's own `task.started` events follow the seed, as the dispatch step publishes them.
    let snapshot = reduceActivityBatch(createActivitySnapshot(), {
      events: mocks.submitted.flat(),
      version: 1,
    });
    for (const [callId, taskId, kind, name] of [
      ["call_deploy", taskIds.deploy, "tool", "deploy"],
      ["call_research", taskIds.researcher, "agent", "researcher"],
    ] as const) {
      const started = createTaskStartedEvent({ callId, kind, name, taskId, turnId: TURN_ID });
      snapshot = reduceActivityBatch(snapshot, {
        events: projectSessionActivity({
          event: {
            ...started,
            meta: { at: "2026-09-30T12:00:01.000Z", id: callId },
          } as MessageStreamEvent,
          sessionId: "session_root",
        }),
        version: 1,
      });
    }

    expect(projectTaskCards(snapshot, { audience: "private" })).toMatchObject([
      {
        state: "working",
        tasks: [
          { kind: "tool", status: "working", title: "Deploy storefront" },
          {
            kind: "agent",
            status: "working",
            title: "researcher: Find the incidents behind the checkout spike",
          },
        ],
        turnId: TURN_ID,
      },
    ]);
  });

  it("never starts a collector for a schedule's session", async () => {
    mocks.context!.set(ScheduleIdKey, "nightly-report");
    const { prepared } = dispatchOfTwoTasks();

    const observed = await observeTaskActivity(prepared);

    expect(observed).toBe(prepared);
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });
});

describe("observePlanActivity", () => {
  it("starts the collector on a root turn's first plan, so a turn without tasks still shows it", async () => {
    const adapter: ChannelAdapter = { kind: "slack", state: {} };
    attachChannelActivityPresenter(adapter, { destination: () => ({}), render: vi.fn() });
    const ctx = mocks.context!;
    ctx.set(ChannelKey, adapter);
    const planned = {
      ...createActionsRequestedEvent({
        actions: [
          {
            callId: "call_plan",
            input: { items: [{ status: "working", title: "Check recent deploys" }] },
            kind: "tool-call",
            toolName: "plan",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: TURN_ID,
      }),
      meta: { at: "2026-09-30T12:00:01.000Z", id: "evt_plan" },
    } as MessageStreamEvent;

    await observePlanActivity({ ctx, event: planned, sessionId: "session_root" });

    expect(mocks.startWorkflow).toHaveBeenCalledOnce();
    expect(ctx.get(ActivityObserverKey)?.sink.url).toMatch(/\/eve\/v1\/activity\//);
    const snapshot = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        ...mocks.submitted.flat(),
        ...projectSessionActivity({ event: planned, sessionId: "session_root" }),
      ],
      version: 1,
    });
    expect(projectTaskCards(snapshot, { audience: "private" })).toEqual([
      {
        plan: [{ status: "working", title: "Check recent deploys" }],
        state: "working",
        tasks: [],
        turnId: TURN_ID,
      },
    ]);
  });
});
