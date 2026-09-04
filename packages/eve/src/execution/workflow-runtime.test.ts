import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context as apiContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  ROOT_CONTEXT,
  context as otelContext,
  trace as otelTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { attachChannelActivityPresentation } from "#channel/activity-renderer.js";
import { ActivityObserverKey } from "#context/keys.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  acceptSubmission,
  dispatchAcceptedSubmission,
  dispatchSessionCommandByToken,
} from "#execution/session/ingress.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  activityCollectorWorkflowReference,
  holdingWorkflowReference,
  turnWorkflowReference,
} from "#execution/workflow-references.js";
import {
  startWorkflowOnAcceptedDeployment,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-start.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { SessionResources } from "#execution/session/resources.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";

const getHookByTokenMock = vi.fn();
const getRunMock = vi.fn();
const cancelRunMock = vi.fn();
const startMock = vi.fn();
const resolveSessionMock = vi.fn();
const resolveHolderMock = vi.fn();
const readEventsMock = vi.fn();
const tailIndexMock = vi.fn();
const session = {
  sessionId: "session-1",
  holderRunId: "holder-1",
  events: { id: "event-log-1" },
  snapshots: { id: "snapshot-log-1" },
  control: { token: "control-1", ownerRunId: "holder-1" },
  initialEventId: "initial-1",
} as SessionResources;

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  cancelRun: (...args: unknown[]) => cancelRunMock(...args),
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getRun: (...args: unknown[]) => getRunMock(...args),
  getWorld: async () => "world",
  start: (...args: unknown[]) => startMock(...args),
}));
vi.mock("#execution/session/directory.js", () => ({
  sessionDirectory: {
    resolveSession: (...args: unknown[]) => resolveSessionMock(...args),
    resolveHolder: (...args: unknown[]) => resolveHolderMock(...args),
  },
}));
vi.mock("#execution/session/events.js", () => ({
  sessionEvents: {
    read: (...args: unknown[]) => readEventsMock(...args),
    tailIndex: (...args: unknown[]) => tailIndexMock(...args),
  },
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

const compiledArtifactsSource = {} as RuntimeCompiledArtifactsSource;
function runtime() {
  return createWorkflowRuntime({ compiledArtifactsSource });
}
const adapter: ChannelAdapter = { kind: "http" };
function createInput() {
  return { adapter, auth: null, input: { message: "hello" }, mode: "conversation" as const };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRunMock.mockReturnValue({ returnValue: Promise.resolve({ terminal: false }) });
  resolveHolderMock.mockResolvedValue(session);
  resolveSessionMock.mockResolvedValue(session);
  getHookByTokenMock.mockResolvedValue({ runId: "holder-1" });
  startMock.mockResolvedValue({
    runId: "candidate-1",
    returnValue: Promise.resolve({ terminal: false }),
  });
  readEventsMock.mockImplementation(
    () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  );
  cancelRunMock.mockResolvedValue(undefined);
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
    compiledArtifactsSource,
    resolvedAgent: { config: {} },
    turnAgent: {
      id: "test-agent",
      instructions: [],
      model: { id: "openai/gpt-5.5" },
      tools: [],
      workspaceSpec: { rootEntries: [] },
    },
  } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workflow deployment dispatch", () => {
  it("uses stable references for independent holder and turn entrypoints", () => {
    const { name } = resolveInstalledPackageInfo();
    expect(holdingWorkflowReference.workflowId).toBe(`workflow//${name}//holdingWorkflow`);
    expect(turnWorkflowReference.workflowId).toBe(`workflow//${name}//turnWorkflow`);
  });

  it("detaches only marked agent telemetry contexts", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    apiContext.setGlobalContextManager(manager);
    const caller = otelTrace.wrapSpanContext({
      isRemote: false,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    });
    const callerContext = otelTrace.setSpan(ROOT_CONTEXT, caller);
    const observed: unknown[] = [];
    startMock.mockImplementation(async () => {
      observed.push(otelTrace.getSpan(otelContext.active()));
      return { runId: "run-1" };
    });
    try {
      await otelContext.with(callerContext, () =>
        startWorkflowOnCurrentDeployment(holdingWorkflowReference, []),
      );
      await otelContext.with(markAgentTraceContext(callerContext), () =>
        startWorkflowOnCurrentDeployment(holdingWorkflowReference, []),
      );
    } finally {
      apiContext.disable();
      manager.disable();
    }
    expect(observed).toEqual([caller, undefined]);
  });

  it("preserves the accepting deployment when dispatch executes elsewhere", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "current");
    await startWorkflowOnAcceptedDeployment(turnWorkflowReference, [], "accepted");
    expect(startMock).toHaveBeenCalledWith(turnWorkflowReference, [], { deploymentId: "accepted" });
  });
});

describe("session ingress", () => {
  it("resolves an alias to its descriptor and starts a turn with the accepted command", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "accepted");
    const command = {
      kind: "send" as const,
      auth: null,
      caller: {
        callId: "call-1",
        replyTo: { kind: "session" as const, token: "parent-turn" },
        subagentName: "research",
      },
      payload: { message: "followup" },
      delivery: { channelKind: "slack", channelName: "team", deliveryId: "delivery-1" },
      turnPolicy: "interrupt" as const,
    };
    await expect(
      runtime().dispatchContinuation({ continuationToken: "slack:thread", command }),
    ).resolves.toEqual({ status: "accepted", sessionId: "session-1" });
    expect(getHookByTokenMock).toHaveBeenCalledWith("slack:thread");
    expect(resolveHolderMock).toHaveBeenCalledWith("holder-1");
    expect(startMock).toHaveBeenCalledWith(
      turnWorkflowReference,
      [
        {
          session,
          submission: { command, eventId: "delivery-1", acceptedDeploymentId: "accepted" },
        },
      ],
      { deploymentId: "accepted" },
    );
  });

  it("uses the fixed session descriptor without a hook lookup or snapshot read", async () => {
    await runtime().dispatchSession({ sessionId: "public-id", command: { kind: "clear" } });
    expect(resolveSessionMock).toHaveBeenCalledWith("public-id");
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledWith(turnWorkflowReference, [
      {
        session,
        submission: expect.objectContaining({
          command: { kind: "clear" },
          eventId: expect.any(String),
        }),
      },
    ]);
    expect(readEventsMock).not.toHaveBeenCalled();
  });

  it("preserves a producer delivery identity and accepted deployment", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "new-deployment");
    const command = {
      kind: "send" as const,
      payload: { message: "retry" },
      taskDeliveryId: "task-delivery",
      delivery: {
        channelKind: "task",
        channelName: "task",
        deliveryId: "delivery",
        acceptedDeploymentId: "accepted-deployment",
      },
    };
    expect(acceptSubmission(command)).toEqual({
      command,
      eventId: "task-delivery",
      acceptedDeploymentId: "accepted-deployment",
    });
  });

  it("keeps distinct commands distinct even when they share a request", () => {
    const command = { kind: "send" as const, payload: { message: "one" }, requestId: "request" };
    expect(acceptSubmission(command).eventId).not.toBe(acceptSubmission(command).eventId);
  });

  it("resolves framework session addresses directly for task notifications", async () => {
    await dispatchSessionCommandByToken(
      sessionCommandHookToken("public-id"),
      { kind: "session-timeout" },
      "expiry-id",
    );
    expect(resolveSessionMock).toHaveBeenCalledWith("public-id");
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(startMock.mock.calls[0]?.[1][0].submission.eventId).toBe("expiry-id");
  });

  it.each([
    { command: { kind: "send" as const, payload: {} }, status: "session_not_active" },
    { command: { kind: "cancel" as const }, status: "no_active_turn" },
    { command: { kind: "clear" as const }, status: "no_active_session" },
    { command: { kind: "compact" as const }, status: "no_active_session" },
    { command: { kind: "reset" as const }, status: "no_active_session" },
  ])("maps missing $command.kind targets without starting work", async ({ command, status }) => {
    getHookByTokenMock.mockRejectedValueOnce(new HookNotFoundError("missing"));
    await expect(
      runtime().dispatchContinuation({ continuationToken: "missing", command }),
    ).resolves.toEqual({ status });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("propagates descriptor storage failures instead of treating them as absence", async () => {
    const failure = new Error("storage unavailable");
    resolveSessionMock.mockRejectedValueOnce(failure);
    await expect(
      runtime().dispatchSession({ sessionId: "session", command: { kind: "clear" } }),
    ).rejects.toBe(failure);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("returns the accepted event identity with its candidate", async () => {
    await expect(
      dispatchAcceptedSubmission(session, {
        eventId: "accepted-input",
        command: { kind: "clear" },
      }),
    ).resolves.toMatchObject({
      eventId: "accepted-input",
      sessionId: "session-1",
      run: { runId: "candidate-1" },
    });
  });

  it.each(["reset", "cancel"] as const)(
    "classifies a terminal %s using only its own receipt disposition",
    async (kind) => {
      getRunMock.mockImplementationOnce(() => ({
        returnValue: Promise.resolve({
          terminal: true,
          deliveries: {
            [startMock.mock.calls[0]![1][0].submission.eventId]: "retired",
            unrelated: "applied",
          },
        }),
      }));
      await expect(
        runtime().dispatchSession({ sessionId: "session-1", command: { kind } }),
      ).resolves.toEqual({
        status: kind === "cancel" ? "no_active_turn" : "no_active_session",
      });
    },
  );

  it.each(["reset", "cancel"] as const)(
    "classifies an already terminal %s whose input was never applied",
    async (kind) => {
      getRunMock.mockReturnValueOnce({
        returnValue: Promise.resolve({ terminal: true, deliveries: { previous: "applied" } }),
      });
      await expect(
        runtime().dispatchSession({ sessionId: "session-1", command: { kind } }),
      ).resolves.toEqual({
        status: kind === "cancel" ? "no_active_turn" : "no_active_session",
      });
    },
  );

  it("accepts a send candidate without waiting for mutable terminal state", async () => {
    startMock.mockResolvedValueOnce({
      runId: "candidate-1",
      returnValue: Promise.resolve({ terminal: true, deliveries: {} }),
    });
    await expect(
      runtime().dispatchSession({
        sessionId: "session-1",
        command: { kind: "send", payload: { message: "late" } },
      }),
    ).resolves.toEqual({ sessionId: "session-1", status: "accepted" });
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it.each(["reset", "cancel"] as const)(
    "waits for %s settlement through the candidate result",
    async (kind) => {
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      startMock.mockResolvedValueOnce({ runId: "reset-run", returnValue: settled });
      getRunMock.mockImplementationOnce(() => ({
        returnValue: settled.then(() => ({
          terminal: true,
          deliveries: { [startMock.mock.calls[0]![1][0].submission.eventId]: "applied" },
        })),
      }));
      let completed = false;
      const reset = runtime()
        .dispatchSession({ sessionId: "session", command: { kind } })
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
      expect(completed).toBe(false);
      finish();
      await expect(reset).resolves.toEqual(
        kind === "reset"
          ? { previousSessionId: "session-1", status: "reset" }
          : { sessionId: "session-1", status: "accepted" },
      );
      expect(getHookByTokenMock).not.toHaveBeenCalled();
    },
  );
});

describe("holder creation", () => {
  it("starts only the holder and places initialization in its first submission", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "accepted");
    const handle = await runtime().createSession({
      ...createInput(),
      continuationToken: "slack:thread",
    });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(
      holdingWorkflowReference,
      [
        {
          initialToken: "slack:thread",
          firstTurn: expect.objectContaining({
            eventId: expect.any(String),
            acceptedDeploymentId: "accepted",
            command: expect.objectContaining({
              kind: "send",
              auth: null,
              payload: { message: "hello" },
            }),
            initial: expect.objectContaining({
              serializedContext: expect.objectContaining({ "eve.mode": "conversation" }),
            }),
          }),
        },
      ],
      expect.objectContaining({ deploymentId: "accepted", allowReservedAttributes: true }),
    );
    expect(resolveHolderMock).toHaveBeenCalledWith("candidate-1");
    expect(handle.sessionId).toBe("session-1");
    expect(readEventsMock).not.toHaveBeenCalled();
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("deduplicates repeated create-once submissions without exposing the alias", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runtime().createSession({
        ...createInput(),
        continuationToken: "http:private-create-id",
      });
    }
    const first = startMock.mock.calls[0]?.[1][0].firstTurn.eventId;
    const second = startMock.mock.calls[1]?.[1][0].firstTurn.eventId;
    expect(first).toMatch(/^create:[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(first).not.toContain("private-create-id");
  });

  it("returns the winning session when its holder loses an initial alias claim", async () => {
    resolveHolderMock.mockResolvedValueOnce({ ...session, sessionId: "winning-session" });
    const result = await runtime().createSession({
      ...createInput(),
      continuationToken: "slack:thread",
    });
    expect(result.sessionId).toBe("winning-session");
  });

  it("retains the exact provider delivery on initial alias contention", async () => {
    const command = {
      kind: "send" as const,
      auth: null,
      payload: { message: "hello", providerField: "retained" },
      delivery: { channelKind: "slack", channelName: "slack", deliveryId: "provider-event" },
    };
    await runtime().createSession({ ...createInput(), continuationConflictCommand: command });
    expect(startMock.mock.calls[0]?.[1][0].firstTurn).toMatchObject({
      eventId: "provider-event",
      command,
    });
  });

  it("keeps initial task ownership and explicit titles", async () => {
    await runtime().createSession({ ...createInput(), taskId: "task-1", title: "Work" });
    expect(startMock.mock.calls[0]?.[1][0].firstTurn.initial.taskId).toBe("task-1");
    expect(startMock.mock.calls[0]?.[2].attributes["$eve.title"]).toBe("Work");
  });

  it("creates a collector only for root channels with activity renderers", async () => {
    vi.stubEnv("VERCEL_URL", "agent.example.com");
    const activityAdapter: ChannelAdapter = { kind: "slack" };
    attachChannelActivityPresentation(activityAdapter, {
      destination: () => ({}),
      renderers: [{ id: "status", render: vi.fn() }],
    });
    startMock
      .mockResolvedValueOnce({ runId: "collector" })
      .mockResolvedValueOnce({ runId: "holder" });
    await runtime().createSession({ ...createInput(), adapter: activityAdapter });
    expect(startMock.mock.calls[0]?.[0]).toBe(activityCollectorWorkflowReference);
    const seed = startMock.mock.calls[1]?.[1][0].firstTurn.initial;
    expect(seed.activityCollectorRunId).toBe("collector");
    expect(seed.serializedContext[ActivityObserverKey.name].sink.url).toContain(
      "https://agent.example.com/eve/v1/activity/",
    );
  });

  it("cancels an orphaned collector when holder startup fails", async () => {
    const activityAdapter: ChannelAdapter = { kind: "slack" };
    attachChannelActivityPresentation(activityAdapter, {
      destination: () => ({}),
      renderers: [{ id: "status", render: vi.fn() }],
    });
    const failure = new Error("start failed");
    startMock.mockResolvedValueOnce({ runId: "collector" }).mockRejectedValueOnce(failure);
    await expect(
      runtime().createSession({ ...createInput(), adapter: activityAdapter }),
    ).rejects.toBe(failure);
    expect(cancelRunMock).toHaveBeenCalledWith("world", "collector", {
      cancelReason: "Root session creation did not complete",
    });
  });
});

describe("resource-based reads", () => {
  it("resolves provider addresses to the descriptor's public session ID", async () => {
    await expect(runtime().resolveContinuation("slack:thread")).resolves.toEqual({
      sessionId: "session-1",
    });
    expect(resolveHolderMock).toHaveBeenCalledWith("holder-1");
  });
  it("returns absence only for an unclaimed provider alias", async () => {
    getHookByTokenMock.mockRejectedValueOnce(new HookNotFoundError("missing"));
    await expect(runtime().resolveContinuation("missing")).resolves.toBeUndefined();
  });
  it("reads events and cursors from the descriptor's event reference", async () => {
    tailIndexMock.mockResolvedValueOnce(12);
    await runtime().getEventStream("public-id", { startIndex: -1 });
    expect(readEventsMock).toHaveBeenCalledWith(session.events, { startIndex: -1 });
    await expect(runtime().getStreamTailIndex("public-id")).resolves.toBe(12);
    expect(tailIndexMock).toHaveBeenCalledWith(session.events);
  });
});
