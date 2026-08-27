import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { emitTaskViewDeliveriesStep } from "#execution/tasks/parent/client-events.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#channel/adapter-context.js", () => ({ buildAdapterContext: vi.fn() }));
vi.mock("#channel/adapter.js", () => ({ callAdapterEventHandler: vi.fn() }));
vi.mock("#context/hook-lifecycle.js", () => ({ dispatchStreamEventHooks: vi.fn() }));
vi.mock("#context/run-step.js", () => ({ withContextScope: vi.fn() }));
vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: vi.fn(),
}));
vi.mock("#execution/channel-context.js", () => ({ setChannelContext: vi.fn() }));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/durable-session-store.js")>()),
  createDurableSessionState: vi.fn(),
  readDurableSession: vi.fn(),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: vi.fn(),
}));
vi.mock("#execution/reconcile-session-continuation-token.js", () => ({
  reconcileSessionContinuationToken: vi.fn(),
}));
vi.mock("#execution/session.js", () => ({ hydrateDurableSession: vi.fn() }));

const metadata = {
  agentId: "agent_1",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "research",
};
const view = { metadata, status: "working", taskId: "task_1" } satisfies TaskView;
const sessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1 as const,
};

describe("task client event emission", () => {
  beforeEach(() => vi.resetAllMocks());

  it("drops a view not indexed by the parent session", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({ state: {} } as never);
    const writes: Uint8Array[] = [];

    const result = await emitTaskViewDeliveriesStep({
      deliveries: [{ view }],
      parentWritable: new WritableStream({
        write(chunk) {
          writes.push(chunk);
        },
      }),
      serializedContext: {},
      sessionState,
    });

    expect(result).toEqual({ serializedContext: {}, sessionState });
    expect(writes).toEqual([]);
    expect(deserializeContext).not.toHaveBeenCalled();
  });

  it("emits an owned client view without private executor routing", async () => {
    const durable = {
      state: {
        "eve.tasks": {
          tasks: [
            {
              createdByStepIndex: 0,
              createdByTurnId: "turn_1",
              metadata,
              taskId: "task_1",
              taskInboxToken: "task-token",
              taskRunId: "task-run",
            },
          ],
        },
      },
    };
    const executorView = {
      ...view,
      executor: { childSessionId: "child-secret", childTurnId: "turn-child" },
    } satisfies TaskView;
    const adapter = { kind: "test" };
    const bundle = { hookRegistry: { streamEventsByType: new Map(), streamEventsWildcard: [] } };
    const ctx = {
      require: vi.fn().mockReturnValueOnce(adapter).mockReturnValueOnce(bundle),
    };
    const session = { sessionId: "parent-session" };
    const nextState = { ...sessionState, continuationToken: "next-token" };
    vi.mocked(readDurableSession).mockResolvedValue(durable as never);
    vi.mocked(deserializeContext).mockResolvedValue(ctx as never);
    vi.mocked(resolveEffectiveAgentRuntime).mockReturnValue({
      thresholdPercent: 0.8,
      turnAgent: {},
    } as never);
    vi.mocked(hydrateDurableSession).mockReturnValue(session as never);
    vi.mocked(buildAdapterContext).mockReturnValue({ state: {} } as never);
    vi.mocked(callAdapterEventHandler).mockImplementation(async (_adapter, event) => event);
    vi.mocked(withContextScope).mockImplementation(
      async (_ctx, scoped, callback) => await callback(scoped),
    );
    vi.mocked(reconcileSessionContinuationToken).mockReturnValue(session as never);
    vi.mocked(serializeContext).mockReturnValue({ serialized: true });
    vi.mocked(createDurableSessionState).mockReturnValue(nextState);
    const writes: Uint8Array[] = [];

    const result = await emitTaskViewDeliveriesStep({
      deliveries: [{ message: "Checking inventory.", view: executorView }],
      parentWritable: new WritableStream({
        write(chunk) {
          writes.push(chunk);
        },
      }),
      serializedContext: {},
      sessionState,
    });

    const event = JSON.parse(new TextDecoder().decode(writes[0])) as Record<string, unknown>;
    expect(event).toMatchObject({
      data: {
        message: "Checking inventory.",
        task: { metadata, status: "working", taskId: "task_1" },
      },
      type: "task.updated",
    });
    expect(JSON.stringify(event)).not.toContain("child-secret");
    expect(dispatchStreamEventHooks).toHaveBeenCalledOnce();
    expect(setChannelContext).toHaveBeenCalledOnce();
    expect(result).toEqual({ serializedContext: { serialized: true }, sessionState: nextState });
  });
});
