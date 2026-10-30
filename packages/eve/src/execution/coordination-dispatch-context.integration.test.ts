import { expect, it } from "vitest";
import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { withPublished } from "#internal/testing/session-machine.js";
import { ReactionsStateKey } from "#reactions/state.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

it("binds dynamic remote credentials to the dispatch checkpoint's parent view", async () => {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "parent-session");
  ctx.set(ChannelKey, { kind: "http", state: {} } as never);
  ctx.set(BundleKey, {
    resolvedAgent: { config: {} },
    turnAgent: { id: "parent", tools: [], system: "Help Alice.", model: { id: "test/model" } },
    subagentRegistry: { subagentsByName: new Map() },
  } as never);
  ctx.set(ReactionsStateKey, {
    latest: {},
    slots: {
      "subagent:subagents/reviewer": {
        digest: "reviewer",
        since: 0,
        value: {
          kind: "remote",
          prepared: { name: "reviewer" },
          remoteAgent: { description: "Review Alice's report.", credentials: true },
        },
      },
    },
  } as never);
  const checkpoint = createTestSessionState(
    { sessionId: "parent-session" },
    { sequence: 0, turnId: "turn_0" },
  );
  const scope = { runId: "model_0", turnId: "turn_0" };
  const session = hydrateDurableSession({
    durable: readDurableSession(checkpoint),
    turnAgent: ctx.require(BundleKey).turnAgent,
  });
  const requested = withPublished({ ...session, history: [] }, [
    { type: "model.requested", data: { runId: "model_0", owner: { turnId: "turn_0" } }, scope },
  ]);
  const started = withPublished(requested, [
    { type: "model.started", data: { runId: "model_0", modelId: "test/model", attempt: 0 }, scope },
  ]);
  const result = await prepareActionDispatch({
    batch: { event: { sequence: 0, stepIndex: 0, turnId: "turn_0" }, requests: [] },
    ctx,
    durableSession: readDurableSession(createDurableSessionState({ session: started })),
    plan: () => [],
    serializedContext: {},
  });
  expect(result.dynamicSubagentSelections["subagents/reviewer"]).toMatchObject({
    binding: { position: 2, session: { id: "parent-session" } },
  });
  expect(result.workflowAgents.reviewer?.description).toBe("Review Alice's report.");
});
