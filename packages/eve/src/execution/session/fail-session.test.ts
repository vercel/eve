import { describe, expect, it, vi } from "vitest";

import type { TurnCaller } from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { finalizeSession } from "#execution/session/finalization.js";
import { failSession } from "#execution/session/program.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { taskLifecycleViolations } from "#internal/testing/task-lifecycle.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { notifyTurnCallerStep, resolveInitialTurnCallerStep } from "#tasks/child.js";
import { emitSubagentEventStep } from "#tasks/emit-event-step.js";
import { taskEvents } from "#tasks/events.js";

vi.mock("#tasks/child.js", async (importOriginal) => ({
  ...(await importOriginal()),
  notifyTurnCallerStep: vi.fn(),
  resolveInitialTurnCallerStep: vi.fn(),
}));
vi.mock("#tasks/emit-event-step.js", () => ({ emitSubagentEventStep: vi.fn() }));
vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: vi.fn(),
}));
vi.mock("#tasks/timer-steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  armTaskTimerStep: vi.fn(async (input: { sessionState: unknown }) => input),
  cancelTaskTimerStep: vi.fn(async (input: { sessionState: unknown }) => input),
}));
vi.mock("#execution/session/finalization.js", () => ({ finalizeSession: vi.fn() }));

const CALLER: TurnCaller = {
  callId: "call-delegate",
  replyTo: { kind: "hook", token: "owner-inbox" },
  subagentName: "researcher",
};

describe("failSession", () => {
  it("ends the session's tasks on its stream before its caller learns it failed", async () => {
    const working = createTaskRecord({ announced: true, mode: "detached" });
    const base = createTestSessionState({ sessionId: "child" });
    const sessionState = replaceDurableSessionSnapshot({
      session: { ...readDurableSession(base), state: taskTableState([working]) },
      state: base,
    });
    const published: UnstampedMessageStreamEvent[] = [];
    vi.mocked(emitSubagentEventStep).mockImplementation(async (input) => {
      published.push(input.event);
      return { serializedContext: input.serializedContext, sessionState: input.sessionState };
    });
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValue(CALLER);
    vi.mocked(finalizeSession).mockResolvedValue({
      callerReply: { isError: true, output: "boot failed" },
      result: { isError: true, output: "boot failed" },
    });

    await expect(
      failSession({
        error: new Error("boot failed"),
        mode: "conversation",
        serializedContext: {},
        sessionId: "child",
        sessionState,
        sessionWritable: new WritableStream<Uint8Array>(),
      }),
    ).rejects.toThrow("Agent workflow failed.");

    expect(published.map((event) => event.type)).toEqual(["task.settled", "task.ended"]);
    expect(published[0]).toMatchObject({ data: { status: "cancelled", taskId: working.id } });
    const started = taskEvents([{ kind: "started", record: working }], "child");
    expect(taskLifecycleViolations([...started, ...published])).toEqual([]);
    expect(terminateChildSessionsStep).toHaveBeenCalledOnce();
    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "terminal",
      sessionId: "child",
      settled: { isError: true, output: "boot failed" },
    });
    const lastEvent = Math.max(...vi.mocked(emitSubagentEventStep).mock.invocationCallOrder);
    expect(lastEvent).toBeLessThan(vi.mocked(finalizeSession).mock.invocationCallOrder[0]!);
  });
});
