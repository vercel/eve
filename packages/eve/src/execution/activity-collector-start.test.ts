import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachChannelActivityPresenter } from "#channel/activity-presenter.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { projectTaskCards } from "#channel/task-card.js";
import { ContextContainer } from "#context/container.js";
import { ActivityObserverKey, ScheduleIdKey } from "#context/keys.js";
import { observeRootActivity } from "#execution/activity-collector-start.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { projectSessionActivity } from "#execution/session-activity-projection.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import {
  createActionsRequestedEvent,
  createTaskStartedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  startWorkflow: vi.fn(),
  submitted: [] as ActivityEventV1[][],
}));

vi.mock("#context/serialize.js", () => ({
  serializeContext: () => ({}),
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

const SESSION_ID = "session_root";
const TURN_ID = "turn_1";
let clock = 0;

function stamp(event: UnstampedMessageStreamEvent): MessageStreamEvent {
  clock += 1;
  return {
    ...event,
    meta: { at: new Date(Date.UTC(2026, 8, 30, 12, 0, clock)).toISOString(), id: `evt_${clock}` },
  } as MessageStreamEvent;
}

/** A root Slack session's context, whose channel presents activity. */
function rootContext(): ContextContainer {
  const adapter: ChannelAdapter = { kind: "slack", state: {} };
  attachChannelActivityPresenter(adapter, { destination: () => ({}), render: vi.fn() });
  const ctx = new ContextContainer();
  ctx.set(BundleKey, { resolvedAgent: {} } as never);
  ctx.set(ChannelKey, adapter);
  return ctx;
}

/** A model step that checks the logs, then starts a deploy task and a researcher task. */
const LOGS_THEN_TASKS = [
  createActionsRequestedEvent({
    actions: [
      {
        callId: "call_logs",
        input: { service: "storefront" },
        kind: "tool-call",
        toolName: "logs",
      },
    ],
    sequence: 1,
    stepIndex: 0,
    turnId: TURN_ID,
  }),
  createActionsRequestedEvent({
    actions: [
      {
        callId: "call_deploy",
        input: { service: "storefront" },
        kind: "tool-call",
        toolName: "deploy",
      },
      {
        callId: "call_research",
        input: { message: "Find the incidents behind the checkout spike" },
        kind: "tool-call",
        toolName: "researcher",
      },
    ],
    presentation: {
      call_deploy: { label: "Deploy storefront" },
      call_research: { label: "researcher: Find the incidents behind the checkout spike" },
    },
    sequence: 2,
    stepIndex: 1,
    turnId: TURN_ID,
  }),
  createTaskStartedEvent({
    callId: "call_deploy",
    kind: "tool",
    name: "deploy",
    taskId: "deploy-4hd8sa",
    turnId: TURN_ID,
  }),
  createTaskStartedEvent({
    callId: "call_research",
    kind: "agent",
    name: "researcher",
    taskId: "researcher-7k2m9q",
    turnId: TURN_ID,
  }),
];

/** Publishes events as a root session's steps do: start the collector, then project. */
async function publish(ctx: ContextContainer, events: readonly UnstampedMessageStreamEvent[]) {
  for (const unstamped of events) {
    const event = stamp(unstamped);
    await observeRootActivity({ ctx, event, sessionId: SESSION_ID });
    if (!ctx.has(ActivityObserverKey)) continue;
    mocks.submitted.push([
      ...projectSessionActivity({
        event,
        sessionId: SESSION_ID,
        taskCallIds: ["call_deploy", "call_research"],
      }),
    ]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitted = [];
  mocks.startWorkflow.mockResolvedValue({ runId: "collector-run" });
});

describe("observeRootActivity", () => {
  it("starts the collector on a root turn's first tool call, so the card sees the whole turn", async () => {
    const ctx = rootContext();

    await publish(ctx, LOGS_THEN_TASKS);

    expect(mocks.startWorkflow).toHaveBeenCalledOnce();
    expect(ctx.get(ActivityObserverKey)?.sink.url).toMatch(/\/eve\/v1\/activity\/[\w-]{43}$/);
    const snapshot = reduceActivityBatch(createActivitySnapshot(), {
      events: mocks.submitted.flat(),
      version: 1,
    });
    expect(projectTaskCards(snapshot, { audience: "private" })).toMatchObject([
      {
        actions: [{ input: { service: "storefront" }, name: "logs", status: "working" }],
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
    const ctx = rootContext();
    ctx.set(ScheduleIdKey, "nightly-report");

    await publish(ctx, LOGS_THEN_TASKS);

    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(ctx.has(ActivityObserverKey)).toBe(false);
  });
});
