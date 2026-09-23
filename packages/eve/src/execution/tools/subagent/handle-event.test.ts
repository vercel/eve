import { beforeEach, expect, it, vi } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { dispatchSessionEventHooksStep } from "#execution/session/dispatch-event-hooks-step.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { handleSubagentEvent } from "#execution/tools/subagent/handle-event.js";

vi.mock("#execution/session/dispatch-event-hooks-step.js", () => ({
  dispatchSessionEventHooksStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({ emitSubagentEventStep: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const event = stampTestEvent({
  type: "subagent.completed",
  data: { callId: "call", subagentName: "research", output: "done" },
});
const input = {
  event,
  sessionWritable: {} as WritableStream<Uint8Array>,
  serializedContext: {},
  sessionState: createTestSessionState(),
};

it("waits for publication before hooks and returns hook-owned context and session state", async () => {
  const publication = Promise.withResolvers<Awaited<ReturnType<typeof emitSubagentEventStep>>>();
  vi.mocked(emitSubagentEventStep).mockReturnValue(publication.promise);
  const hooked = {
    serializedContext: { hook: true },
    sessionState: createTestSessionState({ continuationToken: "after-hook" }),
  };
  vi.mocked(dispatchSessionEventHooksStep).mockResolvedValue(hooked);
  const handling = handleSubagentEvent(input);
  expect(dispatchSessionEventHooksStep).not.toHaveBeenCalled();
  publication.resolve({ event, suppressed: false, serializedContext: { channel: true } });
  expect(await handling).toBe(hooked);
  expect(dispatchSessionEventHooksStep).toHaveBeenCalledExactlyOnceWith({
    event,
    serializedContext: { channel: true },
    sessionState: input.sessionState,
  });
});

it("skips hooks for suppressed events", async () => {
  vi.mocked(emitSubagentEventStep).mockResolvedValue({
    event,
    suppressed: true,
    serializedContext: { channel: true },
  });
  expect(await handleSubagentEvent(input)).toEqual({
    serializedContext: { channel: true },
    sessionState: input.sessionState,
  });
  expect(dispatchSessionEventHooksStep).not.toHaveBeenCalled();
});

it("propagates a hook failure without repeating publication", async () => {
  vi.mocked(emitSubagentEventStep).mockResolvedValue({
    event,
    suppressed: false,
    serializedContext: {},
  });
  vi.mocked(dispatchSessionEventHooksStep).mockRejectedValue(new Error("hook failed"));
  await expect(handleSubagentEvent(input)).rejects.toThrow("hook failed");
  expect(emitSubagentEventStep).toHaveBeenCalledOnce();
});
