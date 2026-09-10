import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityObserverConfig, RunInput, TurnCaller } from "#channel/types.js";
import { ActivityObserverKey } from "#context/keys.js";
import {
  parseActivityObserverField,
  validateActivityObserverBinding,
} from "#eve-channel/activity-observer-request.js";
import {
  deriveBackgroundTaskActivityObserver,
  deriveRootTurnWorkIdentity,
} from "#execution/activity-work.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { projectSessionActivity } from "#execution/session-activity-projection.js";
import { projectTaskActivity } from "#execution/tasks/child/steps.js";
import { startSubagent, type SubagentStartTarget } from "#execution/tools/subagent/start.js";
import type { ActivityEventV1, ActivitySnapshotV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { createRuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { dispatchToClaimedAgentAddress } from "#subagents/handle-dispatch.js";
import type { AgentAddress } from "#subagents/handles/store.js";
import { bindTurnCallerContextStep } from "#subagents/parent-notification.js";
import type {
  continueRemoteAgentSession as ContinueRemote,
  startRemoteAgentSession as StartRemote,
} from "#subagents/remote-dispatch.js";

type Observer = ActivityObserverConfig & {
  workIdentity: NonNullable<ActivityObserverConfig["workIdentity"]>;
};
type Kind = "local" | "remote";
const { createSession, dispatchSession, startRemote, continueRemote } = vi.hoisted(() => ({
  createSession: vi.fn(async (_input: RunInput) => undefined),
  dispatchSession: vi.fn(async (_input: { command: { caller?: TurnCaller } }) => ({
    status: "accepted",
  })),
  startRemote: vi.fn(async (_input: Parameters<typeof StartRemote>[0]) => ({
    sessionId: "remote-session",
  })),
  continueRemote: vi.fn(async (_input: Parameters<typeof ContinueRemote>[0]) => undefined),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({ createSession, dispatchSession }),
  waitForCommandHookOwner: async () => ({ runId: "child-session" }),
}));
vi.mock("#subagents/remote-dispatch.js", () => ({
  resolveRemoteAgentForAction: () => ({ url: "https://remote.example/eve/v1" }),
  startRemoteAgentSession: startRemote,
  continueRemoteAgentSession: continueRemote,
}));

const at = "2026-01-01T00:00:00.000Z";
const root = deriveRootTurnWorkIdentity({
  sessionId: "parent",
  auth: { current: null, initiator: null },
  turn: { id: "parent-turn", sequence: 0 },
});
const parentObserver: Observer = {
  sink: {
    url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
    version: 1,
  },
  workIdentity: root,
};
const session = {
  sessionId: "parent",
  continuationToken: "parent-token",
  history: [],
  agent: { dynamicModel: true as const, system: "", tools: [] },
  compaction: { recentWindowSize: 5, threshold: 10_000 },
};
const bundle = {
  subagentRegistry: createRuntimeSubagentRegistry({ subagents: [] }),
} as Parameters<typeof startSubagent>[0]["bundle"];

function taskObserver(callId: string): Observer {
  const observer = deriveBackgroundTaskActivityObserver({
    activityObserver: parentObserver,
    callId,
    name: "research",
    parentSessionId: session.sessionId,
    parentTurnId: "parent-turn",
    rootSessionId: session.sessionId,
  });
  if (observer?.workIdentity === undefined) throw new Error("Expected task identity");
  return { ...observer, workIdentity: observer.workIdentity };
}

function target(kind: Kind, callId: string): SubagentStartTarget {
  const action = {
    callId,
    description: "Research",
    input: { message: "Find it" },
    name: "research",
    nodeId: "subagents/research",
  };
  return kind === "local"
    ? {
        kind,
        action: { ...action, kind: "subagent-call", subagentName: "research" },
        source: { type: "runtime" },
      }
    : { kind, action: { ...action, kind: "remote-agent-call", remoteAgentName: "research" } };
}

async function start(kind: Kind, task?: Observer): Promise<ActivityObserverConfig | undefined> {
  const result = await startSubagent({
    auth: null,
    batchEvent: { sequence: 0, turnId: "parent-turn" },
    bundle,
    callbackBaseUrl: "https://parent.example",
    capabilities: undefined,
    channelMetadata: undefined,
    currentSession: session,
    fanoutSize: 1,
    initiatorAuth: null,
    parentContinuationToken: "parent-token",
    parentTraceContext: undefined,
    activityObserver: task === undefined ? undefined : parentObserver,
    taskActivityObserver: task,
    sandboxSessionId: "sandbox",
    serializedContext: {},
    session,
    taskId: "task-a",
    target: target(kind, "task-a"),
  });
  expect(result.kind).toBe("called");
  if (kind === "local") return createSession.mock.calls[0]![0].activityObserver;
  const request = startRemote.mock.calls[0]![0];
  if (request.activityObserver !== undefined) {
    const parsed = parseActivityObserverField(request.activityObserver);
    if (parsed === undefined || parsed instanceof Response) throw new Error("Invalid observer");
    expect(
      validateActivityObserverBinding(parsed, {
        callId: request.action.callId,
        subagentName: request.action.remoteAgentName,
        token: request.callbackToken!,
        url: `${request.callbackBaseUrl}/eve/v1/callback/parent-token`,
      }),
    ).toBeUndefined();
  }
  return request.activityObserver;
}

function apply(snapshot: ActivitySnapshotV1, events: readonly ActivityEventV1[]) {
  return reduceActivityBatch(snapshot, { version: 1, events });
}
function project(event: MessageStreamEvent, observer: ActivityObserverConfig, sessionId = "child") {
  return projectSessionActivity({ event, sessionId, workIdentity: observer.workIdentity });
}
function turn(type: "turn.started" | "turn.completed", turnId: string): MessageStreamEvent {
  return { type, data: { sequence: 0, turnId }, meta: { id: `${type}:${turnId}`, at } };
}
function tool(type: "actions.requested" | "action.result", turnId: string): MessageStreamEvent {
  const data = { turnId, sequence: 1, stepIndex: 0 };
  const meta = { id: `${type}:${turnId}`, at };
  return type === "actions.requested"
    ? {
        type,
        meta,
        data: {
          ...data,
          actions: [{ kind: "tool-call", callId: "search-call", toolName: "search", input: {} }],
        },
      }
    : {
        type,
        meta,
        data: {
          ...data,
          status: "completed",
          result: {
            kind: "tool-result",
            callId: "search-call",
            toolName: "search",
            output: "Found it",
          },
        },
      };
}
function taskEvents(observer: Observer, status: "working" | "completed" | "cancelled") {
  return projectTaskActivity({
    activityObserver: observer,
    settledAt: at,
    view: {
      taskId: observer.workIdentity.callId!,
      metadata: { kind: "subagent", name: "research" },
      ...(status === "completed"
        ? { status, lastOutput: { type: "result" as const, data: "Done" } }
        : { status }),
    },
  });
}
function initialSnapshot() {
  return apply(
    createActivitySnapshot(),
    project(turn("turn.started", "parent-turn"), parentObserver, "parent"),
  );
}

describe("task-owned subagent activity", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["local", "remote"] as const)(
    "keeps one task item through %s child activity and settlement",
    async (kind) => {
      const task = taskObserver("task-a");
      const captured = await start(kind, task);
      if (captured === undefined) throw new Error("Expected child observer");
      expect(captured).toEqual(task);
      let snapshot = apply(initialSnapshot(), taskEvents(task, "working"));
      snapshot = apply(snapshot, project(turn("turn.started", "child-turn"), captured));
      snapshot = apply(snapshot, project(tool("actions.requested", "child-turn"), captured));
      expect(Object.values(snapshot.work)).toHaveLength(2);
      expect(snapshot.work[task.workIdentity.id]).toMatchObject({
        kind: "task",
        parentId: root.id,
        phase: "running",
      });
      expect(Object.values(snapshot.actions)).toEqual([
        expect.objectContaining({ parentWorkId: task.workIdentity.id, phase: "running" }),
      ]);
      snapshot = apply(snapshot, project(tool("action.result", "child-turn"), captured));
      snapshot = apply(snapshot, project(turn("turn.completed", "child-turn"), captured));
      expect(snapshot.work[task.workIdentity.id]?.phase).toBe("running");
      snapshot = apply(snapshot, taskEvents(task, "completed"));
      snapshot = apply(
        snapshot,
        project(turn("turn.completed", "parent-turn"), parentObserver, "parent"),
      );
      expect(Object.values(snapshot.work).map((work) => work.phase)).toEqual([
        "completed",
        "completed",
      ]);
      expect(Object.values(snapshot.actions).map((action) => action.phase)).toEqual(["completed"]);
    },
  );

  it.each(["local", "remote"] as const)(
    "keeps %s observation disabled without an observer",
    async (kind) => {
      expect(await start(kind)).toBeUndefined();
    },
  );

  it.each([
    ["local", "completed"],
    ["local", "cancelled"],
    ["remote", "completed"],
    ["remote", "cancelled"],
  ] as const)("rebinds %s child progress after task A is %s", async (kind, status) => {
    const a = taskObserver("task-a");
    const original = await start(kind, a);
    const b = taskObserver("task-b");
    const address: AgentAddress =
      kind === "local"
        ? { kind: "agent/local", sessionId: "child-session", continuationToken: "child-token" }
        : {
            kind: "agent/remote",
            sessionId: "remote-session",
            callbackBaseUrl: "https://parent.example",
            url: "https://remote.example/eve/v1",
            credentialResolver: { resolverId: "subagents/research" },
          };
    const result = await dispatchToClaimedAgentAddress({
      activityObserver: b,
      action: target(kind, "task-b").action,
      auth: null,
      bundle,
      currentSession: session,
      handle: {
        address,
        identity: { id: "agent-1", name: "research", nodeId: "subagents/research" },
        callId: "task-b",
        operationId: "operation-b",
        ownerId: "task-b",
        phase: "claimed",
      },
      parentToken: "task-b-reply",
      taskId: "task-b",
    });
    expect(result.kind).toBe("called");
    let caller: TurnCaller | undefined;
    if (kind === "local") caller = dispatchSession.mock.calls[0]![0].command.caller;
    else {
      const request = continueRemote.mock.calls[0]![0];
      const parsed = parseActivityObserverField(request.activityObserver);
      if (parsed === undefined || parsed instanceof Response) throw new Error("Invalid observer");
      expect(validateActivityObserverBinding(parsed, request.callback)).toBeUndefined();
      caller = {
        ...request.callback,
        activityObserver: parsed,
        replyTo: { kind: "callback", token: request.callback.token, url: request.callback.url },
      };
    }
    const context = await bindTurnCallerContextStep({
      caller,
      serializedContext: {
        [ActivityObserverKey.name]: original,
        [ChannelKey.name]: {
          kind: SUBAGENT_ADAPTER_KIND,
          state: {
            callId: "task-a",
            parentContinuationToken: "parent-token",
            parentSessionId: "parent",
            subagentName: "research",
          },
        },
      },
    });
    const rebound = context[ActivityObserverKey.name] as ActivityObserverConfig;
    expect(rebound).toEqual(b);
    let snapshot = apply(initialSnapshot(), taskEvents(a, "working"));
    snapshot = apply(snapshot, project(tool("actions.requested", "first-turn"), a));
    snapshot = apply(snapshot, project(tool("action.result", "first-turn"), a));
    snapshot = apply(snapshot, taskEvents(a, status));
    snapshot = apply(snapshot, taskEvents(b, "working"));
    snapshot = apply(snapshot, project(turn("turn.started", "second-turn"), rebound));
    snapshot = apply(snapshot, project(tool("actions.requested", "second-turn"), rebound));
    expect(snapshot.work[a.workIdentity.id]?.phase).toBe(status);
    expect(snapshot.work[b.workIdentity.id]?.phase).toBe("running");
    expect(Object.values(snapshot.actions)).toEqual([
      expect.objectContaining({ parentWorkId: a.workIdentity.id, phase: "completed" }),
      expect.objectContaining({ parentWorkId: b.workIdentity.id, phase: "running" }),
    ]);
  });
});
