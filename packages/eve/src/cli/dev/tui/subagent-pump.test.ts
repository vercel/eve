import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type MessageStreamEvent } from "#client/index.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { UnstampedMessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";

import { SubagentPump, type SubagentView } from "./subagent-pump.js";

afterEach(() => {
  vi.useRealTimers();
});

function fakeView(): SubagentView {
  return {
    begin: vi.fn(),
    background: vi.fn(),
    upsertStep: vi.fn(),
    upsertTool: vi.fn(),
    removeTool: vi.fn(),
    complete: vi.fn(),
    markChildToolCallId: vi.fn(),
  };
}

/**
 * A hand-pumped child response: events pushed after scoped cancellation aborts
 * the pump must never reach the view.
 */
function pushableChildStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted = false;
  const encoder = new TextEncoder();

  return {
    push(event: MessageStreamEvent) {
      if (aborted) return;
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    response(signal?: AbortSignal): Response {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(nextController) {
            controller = nextController;
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                nextController.close();
              },
              { once: true },
            );
          },
        }),
      );
    },
    get aborted() {
      return aborted;
    },
  };
}

function subagentCalled(callId: string, turnId = "turn-1"): SubagentCalledStreamEvent {
  return {
    type: "subagent.called",
    data: {
      callId,
      childSessionId: `child_${callId}`,
      childStreamPath: `/eve/v1/children/${callId}/stream`,
      name: "researcher",
      sequence: 1,
      turnId,
    },
  } as SubagentCalledStreamEvent;
}

function responseOf(events: readonly MessageStreamEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    }),
  );
}

function reasoningEvent(delta: string, index = 0): MessageStreamEvent {
  return stampTestEvent(
    {
      type: "reasoning.appended",
      data: {
        reasoningDelta: delta,
        reasoningSoFar: delta,
        sequence: 2,
        stepIndex: 0,
        turnId: "child-turn",
      },
    } as UnstampedMessageStreamEvent,
    index,
  );
}

function boundaryEvent(index: number): MessageStreamEvent {
  return stampTestEvent(
    { type: "session.waiting", data: { wait: "next-user-message" } } as UnstampedMessageStreamEvent,
    index,
  );
}

function failedBoundaryEvent(index: number): MessageStreamEvent {
  return stampTestEvent(
    {
      type: "session.failed",
      data: { code: "SESSION_FAILED", message: "child failed", sessionId: "child_call-1" },
    } as UnstampedMessageStreamEvent,
    index,
  );
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("SubagentPump.settleCancelledTurn", () => {
  it("cancels only foreground descendants of the exact turn", async () => {
    const backgroundA = pushableChildStream();
    const backgroundB = pushableChildStream();
    const foregroundB = pushableChildStream();
    const streams = new Map([
      ["/eve/v1/children/background-a/stream", backgroundA],
      ["/eve/v1/children/background-b/stream", backgroundB],
      ["/eve/v1/children/foreground-b/stream", foregroundB],
    ]);
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "fetch").mockImplementation(async (path, init) => {
      const child = streams.get(path);
      if (child === undefined) throw new Error(`Unexpected child path: ${path}`);
      return child.response(init?.signal ?? undefined);
    });
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("background-a", "turn-a"));
    pump.background("background-a");
    pump.begin(subagentCalled("background-b", "turn-b"));
    pump.background("background-b");
    pump.begin(subagentCalled("foreground-b", "turn-b"));
    await settleAsyncWork();

    pump.settleCancelledTurn("turn-b");

    expect(view.complete).toHaveBeenCalledTimes(1);
    expect(view.complete).toHaveBeenCalledWith({
      authoritative: true,
      callId: "foreground-b",
    });
    expect(foregroundB.aborted).toBe(true);
    expect(backgroundA.aborted).toBe(false);
    expect(backgroundB.aborted).toBe(false);
    pump.abortAll();
  });

  it("closes live sections and stops stale child output after cancellation", async () => {
    const child = pushableChildStream();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "fetch").mockImplementation(async (_path, init) =>
      child.response(init?.signal ?? undefined),
    );
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    child.push(reasoningEvent("**Searching for current events**", 0));
    await settleAsyncWork();
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", finalized: false }),
    );

    // The parent turn is cancelled: sections settle and the stream stops.
    pump.settleCancelledTurn("turn-1");
    expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" });
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", finalized: true }),
    );

    // A child still flushing output after the cancel paints nothing.
    const updatesAfterSettle = vi.mocked(view.upsertStep).mock.calls.length;
    child.push(reasoningEvent("stale output", 1));
    await settleAsyncWork();
    expect(vi.mocked(view.upsertStep).mock.calls.length).toBe(updatesAfterSettle);

    // The parent's late `subagent.completed` fallback settles as a no-op.
    const completions = vi.mocked(view.complete).mock.calls.length;
    pump.settle("call-1");
    expect(vi.mocked(view.complete).mock.calls.length).toBe(completions);
  });
});

describe("SubagentPump background receipts", () => {
  it("keeps the section open until the child stream reaches its own boundary", async () => {
    const child = pushableChildStream();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "fetch").mockImplementation(async (_path, init) =>
      child.response(init?.signal ?? undefined),
    );
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    pump.background("call-1");

    expect(view.background).toHaveBeenCalledWith({ callId: "call-1" });
    expect(view.complete).not.toHaveBeenCalled();

    child.push(reasoningEvent("still working", 0));
    child.push(boundaryEvent(1));
    await settleAsyncWork();

    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", reasoning: "still working" }),
    );
    expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" });
  });

  it("treats a child failure boundary as authoritative completion", async () => {
    const child = pushableChildStream();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "fetch").mockImplementation(async (_path, init) =>
      child.response(init?.signal ?? undefined),
    );
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    pump.background("call-1");
    child.push(failedBoundaryEvent(0));
    await settleAsyncWork();

    expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" });
  });

  it("reopens after parent completion and upgrades at the child boundary", async () => {
    const child = pushableChildStream();
    const client = new Client({ host: "http://localhost:3000" });
    vi.spyOn(client, "fetch").mockImplementation(async (_path, init) =>
      child.response(init?.signal ?? undefined),
    );
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    pump.settle("call-1");
    expect(view.complete).toHaveBeenCalledWith({ authoritative: false, callId: "call-1" });
    pump.begin(subagentCalled("call-1"));
    expect(view.begin).toHaveBeenCalledOnce();

    child.push(reasoningEvent("delayed output", 0));
    child.push(boundaryEvent(1));
    await settleAsyncWork();

    expect(view.begin).toHaveBeenCalledTimes(2);
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", reasoning: "delayed output" }),
    );
    expect(view.complete).toHaveBeenLastCalledWith({ authoritative: true, callId: "call-1" });
  });
});

describe("SubagentPump child stream transport", () => {
  it("reopens an exhausted source at its cursor without replaying output", async () => {
    vi.useFakeTimers();
    const first = reasoningEvent("looked up ", 0);
    const second = reasoningEvent("the forecast", 1);
    const client = new Client({ host: "http://localhost:3000" });
    const fetch = vi
      .spyOn(client, "fetch")
      .mockResolvedValueOnce(responseOf([first]))
      .mockResolvedValueOnce(responseOf([first, second, boundaryEvent(2)]));
    const view = fakeView();
    const pump = new SubagentPump({ client, view, formatActionResultError: () => "failed" });

    pump.begin(subagentCalled("call-1"));
    await settleAsyncWork();
    await vi.advanceTimersByTimeAsync(100);
    await settleAsyncWork();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/eve/v1/children/call-1/stream",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/eve/v1/children/call-1/stream?startIndex=1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(view.upsertStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoning: "looked up the forecast" }),
    );
    expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" });
  });

  it("uses the parent-authored child path and never the remote URL", async () => {
    const client = new Client({ host: "https://parent.example" });
    const fetch = vi.spyOn(client, "fetch").mockResolvedValue(responseOf([boundaryEvent(0)]));
    const pump = new SubagentPump({ client, view: fakeView(), formatActionResultError: () => "" });
    const called = subagentCalled("remote-call");
    called.data.childStreamPath = "/eve/v1/session/parent/subagents/remote-call/child/stream";
    called.data.remote = { url: "https://remote.example/private" };

    pump.begin(called);
    await settleAsyncWork();

    expect(fetch).toHaveBeenCalledWith(
      called.data.childStreamPath,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch.mock.calls.flatMap((call) => call).join(" ")).not.toContain("remote.example");
  });

  it("does not reopen after abortAll", async () => {
    vi.useFakeTimers();
    const client = new Client({ host: "http://localhost:3000" });
    const fetch = vi.spyOn(client, "fetch").mockResolvedValue(responseOf([]));
    const pump = new SubagentPump({ client, view: fakeView(), formatActionResultError: () => "" });

    pump.begin(subagentCalled("call-1"));
    await settleAsyncWork();
    pump.abortAll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetch).toHaveBeenCalledOnce();
  });
});
