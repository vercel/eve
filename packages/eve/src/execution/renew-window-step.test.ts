import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { renewSessionUsageWindowStep } from "#execution/renew-window-step.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import {
  getSessionUsageWindow,
  getSessionUsageWindowIndex,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

const mocks = vi.hoisted(() => ({ resumeHook: vi.fn(async () => undefined) }));
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: mocks.resumeHook }));

/** A worker session that spent 35M and runs two tasks: `pages`, started, and `notes`, not yet. */
function workerSession(): DurableSessionState {
  const base = createTestSessionState({ sessionId: "worker-b" });
  const spent = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 35_000_000,
    outputTokens: 0,
    sawCost: false,
  };
  let table = readTaskTable(undefined);
  for (const name of ["pages", "notes"]) {
    const created = createTask(table, {
      callId: `${name}-call`,
      kind: "agent",
      name,
      resumable: true,
      turnId: "turn_1",
    });
    table = recordTaskRun(created.table, created.taskId, {
      hookToken: `${name}-control`,
      runId: `${name}-run`,
    });
    if (name === "pages") table = markTaskRunStarted(table, created.taskId, "pages-run").table;
  }
  const session = writeTaskTable(
    setTurnUsageState(base.snapshot.session, { ...spent, session: spent, turnId: "turn_1" }),
    table,
  );
  return { ...base, snapshot: { session } };
}

async function renew(sessionState: DurableSessionState, renewalId: string) {
  const values = { history: [], serializedContext: {}, sessionState };
  const { stateDelta } = await renewSessionUsageWindowStep({
    ...values,
    renewalId,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
  return applySessionStateDelta(values, stateDelta).sessionState;
}

describe("renewSessionUsageWindowStep", () => {
  it("starts a new window once per approval and passes it to the started runs", async () => {
    const renewed = await renew(workerSession(), "root:1:limit:usage:0");

    expect(getSessionUsageWindow(readDurableSession(renewed)).inputTokens).toBe(0);
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect(mocks.resumeHook).toHaveBeenCalledWith("pages-control", {
      kind: "renew-window",
      renewalId: "root:1:limit:usage:0",
    });

    const again = await renew(renewed, "root:1:limit:usage:0");
    expect(getSessionUsageWindowIndex(readDurableSession(again))).toBe(
      getSessionUsageWindowIndex(readDurableSession(renewed)),
    );
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
  });
});
