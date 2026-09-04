import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";
import { createSessionResources } from "#execution/session/resources.js";
import type { SnapshotRecordRef } from "#execution/session/resources.js";
import type {
  TurnExecutionResult,
  TurnProgress,
  TurnReceipt,
  TurnWorkflowInput,
} from "#execution/turn/types.js";

const mocks = vi.hoisted(() => ({
  createOwnerInbox: vi.fn(),
  executeTurnStep: vi.fn(),
  finalizeTurnStep: vi.fn(),
  failTurnStep: vi.fn(),
  deferTurnStep: vi.fn(),
  forwardSubmissionStep: vi.fn(),
  awaitTurnStep: vi.fn(),
  awaitRunStep: vi.fn(),
  sendInboxStep: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "candidate" }),
  sleep: mocks.sleep,
}));
vi.mock("#execution/inbox/owner.js", () => ({ createOwnerInbox: mocks.createOwnerInbox }));
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: mocks.sendInboxStep }));
vi.mock("#execution/turn/execute.js", () => ({ executeTurnStep: mocks.executeTurnStep }));
vi.mock("#execution/turn/finalize.js", () => ({
  finalizeTurnStep: mocks.finalizeTurnStep,
  failTurnStep: mocks.failTurnStep,
}));
vi.mock("#execution/session/dispatch.js", () => ({ deferTurnStep: mocks.deferTurnStep }));
vi.mock("#execution/turn/admission.js", () => ({
  forwardSubmissionStep: mocks.forwardSubmissionStep,
  awaitTurnStep: mocks.awaitTurnStep,
}));
vi.mock("#internal/workflow/await-run.js", () => ({
  awaitRunStep: mocks.awaitRunStep,
}));
import { turnWorkflow } from "#execution/turn/workflow.js";

const input: TurnWorkflowInput = {
  session: createSessionResources("session", "input"),
  submission: { eventId: "input", command: { kind: "send", payload: { message: "hello" } } },
};
const receipt: TurnReceipt = { deliveries: { input: "applied" }, terminal: false };
const checkpoint = { id: "checkpoint" } as SnapshotRecordRef;
function progress(overrides: Partial<TurnProgress> = {}): TurnExecutionResult {
  return {
    kind: "progress",
    progress: {
      checkpoint,
      turnId: "turn_candidate",
      action: "settle",
      terminal: false,
      continuationToken: "",
      ...overrides,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function flush() {
  for (let count = 0; count < 12; count++) await Promise.resolve();
}
function testInbox() {
  const buffer: InboxEnvelope[] = [];
  let waiting: ((event: InboxEnvelope) => void) | undefined;
  let observer: ((event: InboxEnvelope) => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;
  const stop = vi.fn(() => {
    observer = undefined;
    onError = undefined;
  });
  const inbox: OwnerInbox = {
    address: { token: "eve:turn:session", ownerRunId: "candidate" },
    claim: vi.fn(async () => ({ kind: "owned" as const })),
    drain: vi.fn(() => buffer.splice(0)),
    next: vi.fn(
      () =>
        new Promise<InboxEnvelope>((resolve) => {
          waiting = resolve;
        }),
    ),
    response: vi.fn(async (requestId) => ({
      eventId: requestId,
      kind: "rekey.response",
      requestId,
      payload: { status: "claimed" },
    })),
    observe: vi.fn((listener, failure) => {
      observer = listener;
      onError = failure;
      return stop;
    }),
    dispose: vi.fn(async () => {}),
  };
  return {
    inbox,
    stop,
    fail: (error: unknown) => onError?.(error),
    push: (event: InboxEnvelope) => {
      observer?.(event);
      if (waiting === undefined) buffer.push(event);
      else {
        const accept = waiting;
        waiting = undefined;
        accept(event);
      }
    },
  };
}
function submit(
  command: TurnWorkflowInput["submission"]["command"],
  eventId = "next",
): InboxEnvelope {
  return {
    eventId,
    kind: "session.submit",
    payload: { submission: { eventId, command }, candidateRunId: "next-owner" },
  };
}

describe("turn workflow ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.finalizeTurnStep.mockResolvedValue(receipt);
    mocks.failTurnStep.mockResolvedValue({ deliveries: {}, terminal: true });
    mocks.sendInboxStep.mockResolvedValue("delivered");
    mocks.sleep.mockResolvedValue(undefined);
    mocks.awaitRunStep.mockImplementation(() => new Promise(() => {}));
  });

  it("disposes a failed claim without finalizing state it never owned", async () => {
    const { inbox } = testInbox();
    vi.mocked(inbox.claim).mockRejectedValue(new Error("claim failed"));
    mocks.createOwnerInbox.mockReturnValue(inbox);
    await expect(turnWorkflow(input)).rejects.toThrow("claim failed");
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(mocks.failTurnStep).not.toHaveBeenCalled();
  });

  it("stops its observer when the first execution fails", async () => {
    const { inbox, stop } = testInbox();
    mocks.createOwnerInbox.mockReturnValue(inbox);
    mocks.executeTurnStep.mockRejectedValue(new Error("model failed"));
    await turnWorkflow(input);
    expect(stop).toHaveBeenCalledOnce();
    expect(inbox.dispose).toHaveBeenCalledOnce();
    expect(mocks.failTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ error: "model failed" }),
    );
  });

  it("starts a FIFO deferral while owned without treating start failure as session failure", async () => {
    const { inbox } = testInbox();
    mocks.createOwnerInbox.mockReturnValue(inbox);
    mocks.executeTurnStep.mockResolvedValue({ kind: "wait", runId: "earlier" });
    mocks.deferTurnStep.mockImplementation(async () => {
      expect(inbox.dispose).not.toHaveBeenCalled();
      throw new Error("start failed");
    });
    await expect(turnWorkflow(input)).rejects.toThrow("start failed");
    expect(mocks.deferTurnStep).toHaveBeenCalledWith({ ...input, afterRunId: "earlier" });
    expect(mocks.failTurnStep).not.toHaveBeenCalled();
    expect(inbox.dispose).toHaveBeenCalledOnce();
  });

  it("reclaims after forwarding returns an unaccounted continuation receipt", async () => {
    const first = testInbox().inbox;
    vi.mocked(first.claim).mockResolvedValue({ kind: "conflict", runId: "old-owner" });
    const second = testInbox().inbox;
    mocks.createOwnerInbox.mockReturnValueOnce(first).mockReturnValueOnce(second);
    mocks.forwardSubmissionStep.mockResolvedValue({
      deliveries: {},
      terminal: false,
      continuedTo: "deferred-behind-candidate",
    });
    mocks.executeTurnStep.mockResolvedValue({ kind: "receipt", receipt });
    await expect(turnWorkflow(input)).resolves.toEqual(receipt);
    expect(mocks.createOwnerInbox).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("aborts targeted control but awaits model quiescence before finalization", async () => {
    const actor = testInbox();
    const model = deferred<TurnExecutionResult>();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.executeTurnStep.mockReturnValue(model.promise);
    const run = turnWorkflow(input);
    await flush();
    actor.push(submit({ kind: "cancel", turnId: "stale-turn" }, "stale"));
    const signal = mocks.executeTurnStep.mock.calls[0]![0].abortSignal as AbortSignal;
    expect(signal.aborted).toBe(false);
    actor.push(submit({ kind: "cancel", turnId: "turn_candidate" }));
    expect(signal.aborted).toBe(true);
    expect(mocks.finalizeTurnStep).not.toHaveBeenCalled();
    expect(actor.inbox.dispose).not.toHaveBeenCalled();
    model.resolve(progress());
    await run;
    expect(mocks.finalizeTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cancel" }),
    );
  });

  it("aborts on reader failure and waits for the model before failing the turn", async () => {
    const actor = testInbox();
    const model = deferred<TurnExecutionResult>();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.executeTurnStep.mockReturnValue(model.promise);
    const run = turnWorkflow(input);
    await flush();
    actor.fail(new Error("reader failed"));
    expect(mocks.executeTurnStep.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    expect(mocks.failTurnStep).not.toHaveBeenCalled();
    model.resolve(progress());
    await run;
    expect(mocks.failTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ error: "reader failed" }),
    );
    expect(actor.stop).toHaveBeenCalledOnce();
  });

  it("wakes sleeping work on input and does not repeat a model sleep after events", async () => {
    const actor = testInbox();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.sleep.mockReturnValue(new Promise(() => {}));
    mocks.executeTurnStep
      .mockResolvedValueOnce(
        progress({ action: "wait", sleepDurationMs: 1000, sleepKey: "model-1" }),
      )
      .mockResolvedValueOnce(
        progress({ action: "wait", sleepDurationMs: 1000, sleepKey: "model-1" }),
      );
    const run = turnWorkflow(input);
    await flush();
    actor.push({ eventId: "report", kind: "tool.report", payload: {} });
    await flush();
    expect(mocks.executeTurnStep).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenCalledOnce();
    actor.push(submit({ kind: "cancel" }));
    await run;
    expect(mocks.finalizeTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cancel" }),
    );
  });

  it("retains the pending inbox read after a sleep expires", async () => {
    const actor = testInbox();
    const timer = deferred<void>();
    const model = deferred<TurnExecutionResult>();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.sleep.mockReturnValue(timer.promise);
    mocks.executeTurnStep
      .mockResolvedValueOnce(
        progress({ action: "continue", sleepDurationMs: 1000, sleepKey: "model-1" }),
      )
      .mockReturnValueOnce(model.promise)
      .mockResolvedValueOnce(progress());
    const run = turnWorkflow(input);
    await flush();
    timer.resolve();
    await flush();
    const steer = submit({ kind: "send", payload: { message: "steer" } });
    actor.push(steer);
    model.resolve(progress());
    await run;
    expect(mocks.executeTurnStep.mock.calls[2]![0].work).toEqual({
      kind: "model",
      envelopes: [steer],
    });
    expect(actor.inbox.next).toHaveBeenCalledOnce();
  });

  it("scopes holder rekey deduplication to the requesting owner", async () => {
    const actor = testInbox();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.executeTurnStep.mockResolvedValue(progress({ continuationToken: "channel-token" }));
    await turnWorkflow(input);
    expect(mocks.sendInboxStep).toHaveBeenCalledWith(
      input.session.control,
      expect.objectContaining({
        eventId: "candidate:rekey:channel-token",
        requestId: "candidate:rekey:channel-token",
      }),
    );
  });
  it("waits for the durable outcome after executor completion and watches each run once", async () => {
    const actor = testInbox();
    const completed = deferred<void>();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.awaitRunStep.mockReturnValue(completed.promise);
    mocks.executeTurnStep
      .mockResolvedValueOnce(progress({ action: "wait", pendingRunIds: ["tool-run"] }))
      .mockResolvedValueOnce(progress());
    const run = turnWorkflow(input);
    await flush();
    completed.resolve();
    await flush();
    expect(mocks.awaitRunStep).toHaveBeenCalledExactlyOnceWith("tool-run");
    expect(mocks.finalizeTurnStep).not.toHaveBeenCalled();
    actor.push({ eventId: "outcome", kind: "tool.outcome", payload: {} });
    await run;
    expect(mocks.executeTurnStep.mock.calls[1]![0].work.kind).toBe("events");
  });

  it("fails a waiting owner on native executor failure without polling", async () => {
    const actor = testInbox();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.awaitRunStep.mockRejectedValue(new Error("executor failed"));
    mocks.executeTurnStep.mockResolvedValue(
      progress({ action: "wait", pendingRunIds: ["tool-run"] }),
    );
    await turnWorkflow(input);
    expect(mocks.failTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ error: "executor failed" }),
    );
    expect(mocks.awaitRunStep).toHaveBeenCalledOnce();
  });

  it("claims a token produced during finalization before releasing the owner", async () => {
    const actor = testInbox();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.executeTurnStep.mockResolvedValue(progress({ continuationToken: "model-token" }));
    mocks.finalizeTurnStep.mockResolvedValue({ ...receipt, continuationToken: "settled-token" });
    await turnWorkflow(input);
    expect(mocks.sendInboxStep.mock.calls.map((call) => call[1].payload.token)).toEqual([
      "model-token",
      "settled-token",
    ]);
    expect(mocks.sendInboxStep.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(actor.inbox.dispose).mock.invocationCallOrder[0]!,
    );
  });
  it("reuses an already acknowledged alias from the checkpoint", async () => {
    const actor = testInbox();
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.executeTurnStep.mockResolvedValue(
      progress({ continuationToken: "existing", claimedContinuationToken: "existing" }),
    );
    await turnWorkflow(input);
    expect(mocks.sendInboxStep).not.toHaveBeenCalled();
    expect(mocks.finalizeTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ claimedContinuationToken: "existing" }),
    );
  });
  it("awaits model quiescence when an executor fails during foreground work", async () => {
    const actor = testInbox();
    const model = deferred<TurnExecutionResult>();
    let failExecutor!: (error: Error) => void;
    mocks.createOwnerInbox.mockReturnValue(actor.inbox);
    mocks.awaitRunStep.mockReturnValue(
      new Promise((_resolve, reject) => {
        failExecutor = reject;
      }),
    );
    mocks.executeTurnStep
      .mockResolvedValueOnce(progress({ action: "continue", pendingRunIds: ["tool-run"] }))
      .mockReturnValueOnce(model.promise);
    const run = turnWorkflow(input);
    await flush();
    failExecutor(new Error("executor failed during model"));
    await flush();
    expect(mocks.executeTurnStep.mock.calls[1]![0].abortSignal.aborted).toBe(true);
    expect(mocks.failTurnStep).not.toHaveBeenCalled();
    expect(actor.inbox.dispose).not.toHaveBeenCalled();
    model.resolve(progress());
    await run;
    expect(mocks.failTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ error: "executor failed during model" }),
    );
  });
});
