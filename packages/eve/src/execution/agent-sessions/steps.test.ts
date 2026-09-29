import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityObserverConfig } from "#channel/types.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import {
  openAgentSessionStep,
  sendAgentSessionMessageStep,
} from "#execution/agent-sessions/steps.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import { projectSessionActivity } from "#execution/session-activity-projection.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import {
  createWorkflowRuntime,
  dispatchWorkflowSessionCommand,
} from "#execution/workflow-runtime.js";
import { parseSessionMessageBody } from "#eve-channel/request.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

const researcher = {
  description: "Researches a topic.",
  kind: "subagent",
  name: "researcher",
  nodeId: "agents/researcher",
};
const writer = {
  description: "Writes a summary.",
  kind: "subagent",
  name: "writer",
  nodeId: "agents/writer",
};
const remoteResearcher = {
  description: "Researches a topic remotely.",
  kind: "remote",
  logicalPath: "agents/remote-research.ts",
  name: "remote_research",
  nodeId: "agents/remote-research",
  path: "/eve/v1/session",
  sourceId: "agents/remote-research.ts",
  sourceKind: "module",
  url: "https://remote.example.com",
};

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example.com" }),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => {
    const definitions = [researcher, writer, remoteResearcher];
    return {
      compiledArtifactsSource: { kind: "test" },
      subagentRegistry: {
        subagentsByName: new Map(
          definitions.map((definition) => [definition.name, { definition }]),
        ),
        subagentsByNodeId: new Map(
          definitions.map((definition) => [definition.nodeId, { definition }]),
        ),
      },
    };
  },
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(),
  dispatchWorkflowSessionCommand: vi.fn(async () => ({ status: "accepted" })),
  requestWorkflowTurnCancellation: vi.fn(),
  waitForCommandHookOwner: vi.fn(async () => ({ runId: "child" })),
}));

const at = "2026-01-01T00:00:00.000Z";
const rootWorkId = deriveRootTurnActivityWorkId({ sessionId: "parent", turnId: "turn-1" });
const auth = { current: null, initiator: null };

function callerContext(): AgentSessionContext {
  return {
    activityObserver: {
      sink: {
        url: "https://parent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
        version: 1,
      },
      workIdentity: {
        id: rootWorkId,
        kind: "root-turn",
        rootSessionId: "parent",
        rootTurnId: "turn-1",
        sessionId: "parent",
        turnId: "turn-1",
      },
    },
    agents: {},
    bundle: { source: { kind: "test" } as never },
    dynamicSelections: {},
    limits: {},
    parent: {
      callId: "call-1",
      rootSessionId: "parent",
      sessionId: "parent",
      turn: { id: "turn-1", sequence: 0 },
    },
    sandbox: { sessionId: "parent" },
    trace: { originAudience: { kind: "unknown" } } as never,
  };
}

function childTurn(turnId: string): MessageStreamEvent[] {
  const coordinates = { sequence: 0, stepIndex: 0, turnId };
  return [
    { data: { sequence: 0, turnId }, meta: { at, id: `${turnId}:started` }, type: "turn.started" },
    {
      data: {
        ...coordinates,
        actions: [{ callId: "search-1", input: {}, kind: "tool-call", toolName: "search" }],
      },
      meta: { at, id: `${turnId}:actions` },
      type: "actions.requested",
    },
    {
      data: { sequence: 0, turnId },
      meta: { at, id: `${turnId}:completed` },
      type: "turn.completed",
    },
  ];
}

function rootTurnStarted() {
  return projectSessionActivity({
    event: {
      data: { sequence: 0, turnId: "turn-1" },
      meta: { at, id: "parent:started" },
      type: "turn.started",
    },
    sessionId: "parent",
  });
}

function childSessionActivity(
  sessionId: string,
  observer: ActivityObserverConfig | undefined,
  events: readonly MessageStreamEvent[],
) {
  return events.flatMap((event) =>
    projectSessionActivity({ event, sessionId, workIdentity: observer?.workIdentity }),
  );
}

function localChildRuntime() {
  const createSession = vi.fn(async (_input: { activityObserver?: ActivityObserverConfig }) => ({
    sessionId: "child",
  }));
  vi.mocked(createWorkflowRuntime).mockReturnValue({ createSession } as never);
  return createSession;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("agent session activity", () => {
  it("reports a local agent's turns as its own work that settles when the turn ends", async () => {
    const createSession = localChildRuntime();
    const context = callerContext();

    const address = await openAgentSessionStep({
      auth,
      context,
      key: "run-1:0",
      message: "Research the topic.",
      name: "researcher",
      replyTo: "reply-1",
    });
    await sendAgentSessionMessageStep({
      address,
      auth,
      context,
      key: "run-1:0",
      message: "Go deeper.",
      replyTo: "reply-2",
    });

    const opened = createSession.mock.calls[0]?.[0].activityObserver;
    const sent = vi.mocked(dispatchWorkflowSessionCommand).mock.calls[0]?.[0].command;
    expect(sent).toMatchObject({ caller: { activityObserver: opened } });
    const events = [
      ...rootTurnStarted(),
      ...childSessionActivity("child", opened, [
        { data: {}, meta: { at, id: "child:session" }, type: "session.started" },
        ...childTurn("turn_0"),
      ]),
    ];
    const snapshot = reduceActivityBatch(createActivitySnapshot(), { events, version: 1 });

    const childWorkId = opened?.workIdentity?.id ?? "";
    expect(snapshot.work).toEqual({
      [rootWorkId]: expect.objectContaining({ kind: "root-turn", phase: "running" }),
      [childWorkId]: expect.objectContaining({
        callId: "call-1",
        kind: "subagent",
        name: "researcher",
        parentId: rootWorkId,
        phase: "completed",
      }),
    });
    expect(Object.values(snapshot.actions)).toEqual([
      expect.objectContaining({ name: "search", parentWorkId: childWorkId }),
    ]);
  });

  it("reports each session one call opens as its own work that settles with its own turn", async () => {
    const createSession = localChildRuntime();
    const context = callerContext();
    for (const [index, name] of ["researcher", "writer"].entries()) {
      await openAgentSessionStep({
        auth,
        context,
        key: `run-1:${String(index)}`,
        message: "Work on the topic.",
        name,
        replyTo: `reply-${String(index)}`,
      });
    }
    const [research, write] = createSession.mock.calls.map(([input]) => input.activityObserver);
    const researchId = research?.workIdentity?.id ?? "";
    const writeId = write?.workIdentity?.id ?? "";
    const started: MessageStreamEvent = {
      data: {},
      meta: { at, id: "session" },
      type: "session.started",
    };

    const researchDone = reduceActivityBatch(createActivitySnapshot(), {
      events: [
        ...rootTurnStarted(),
        ...childSessionActivity("research-child", research, [started, ...childTurn("turn_0")]),
        ...childSessionActivity("write-child", write, [started, childTurn("turn_0")[0]!]),
      ],
      version: 1,
    });
    expect(researchDone.work).toEqual({
      [rootWorkId]: expect.objectContaining({ phase: "running" }),
      [researchId]: expect.objectContaining({ name: "researcher", phase: "completed" }),
      [writeId]: expect.objectContaining({ name: "writer", phase: "running" }),
    });

    const [, writeActions, writeEnd] = childTurn("turn_0");
    const writing = reduceActivityBatch(researchDone, {
      events: childSessionActivity("write-child", write, [writeActions!]),
      version: 1,
    });
    expect(Object.values(writing.actions)).toContainEqual(
      expect.objectContaining({ parentWorkId: writeId, phase: "running" }),
    );

    const bothDone = reduceActivityBatch(writing, {
      events: childSessionActivity("write-child", write, [writeEnd!]),
      version: 1,
    });
    expect(bothDone.work[writeId]).toMatchObject({ phase: "completed" });
    expect(bothDone.work[rootWorkId]).toMatchObject({ phase: "running" });
  });

  it("opens and continues a remote agent with one activity identity the remote accepts", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        ok: true,
        protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        sessionId: "remote-session",
        status: "accepted",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = callerContext();

    const address = await openAgentSessionStep({
      auth,
      context,
      key: "run-1:0",
      message: "Research the topic.",
      name: "remote_research",
      replyTo: "reply-1",
    });
    await sendAgentSessionMessageStep({
      address,
      auth,
      context,
      key: "run-1:0",
      message: "Go deeper.",
      replyTo: "reply-2",
    });

    const [opened, continued] = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>,
    );
    expect(continued?.activityObserver).toEqual(opened?.activityObserver);
    expect(parseSessionMessageBody(continued ?? {})).toMatchObject({
      activityObserver: {
        workIdentity: { callId: "call-1", kind: "remote-agent", parentId: rootWorkId },
      },
    });
  });
});
