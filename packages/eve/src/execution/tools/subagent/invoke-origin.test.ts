import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { prepareOwnerAgentInvocation } from "./invoke-preparation.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/coordination-dispatch-shared.js", () => ({ prepareActionDispatch: vi.fn() }));

describe("background invocation origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const ctx = new ContextContainer();
    ctx.set(BundleKey, {
      subagentRegistry: {
        subagentsByName: new Map([
          [
            "research",
            {
              definition: {
                kind: "subagent",
                name: "research",
                nodeId: "research",
                description: "Research",
              },
            },
          ],
        ]),
      },
    } as never);
    vi.mocked(deserializeContext).mockResolvedValue(ctx);
  });

  it.each([true, false])(
    "uses the task's creating turn after the parent advances: task=%s",
    async (background) => {
      const session = recordSessionTask(
        setHarnessEmissionState(
          {
            agent: { dynamicModel: true, system: "", tools: [] },
            compaction: { recentWindowSize: 5, threshold: 10_000 },
            continuationToken: "parent-token",
            history: [],
            sessionId: "parent",
          },
          { sessionStarted: true, sequence: 3, stepIndex: 2, turnId: "turn-3" },
        ),
        {
          taskId: "task",
          taskRunId: "task-run",
          taskInboxToken: "task-inbox",
          createdByTurnId: "turn-1",
          createdByStepIndex: 0,
          metadata: { kind: "subagent", name: "research", agentId: "agent" },
        },
      );
      await prepareOwnerAgentInvocation({
        invocation: { target: "research", message: "Review Alice's plan" },
        invocationId: "original-call",
        serializedContext: {},
        sessionState: createDurableSessionState({ session }),
        taskId: background ? "task" : undefined,
      });
      expect(prepareActionDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          batch: expect.objectContaining({
            event: expect.objectContaining({
              turnId: background ? "turn-1" : "turn-3",
              stepIndex: background ? 0 : 2,
            }),
          }),
        }),
      );
    },
  );
});
