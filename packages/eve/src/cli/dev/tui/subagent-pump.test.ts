import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type MessageStreamEvent } from "#client/index.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  type TaskChildStream,
  type TaskStartedStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

import { SubagentPump, type SubagentView } from "./subagent-pump.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

interface ChildRequest {
  readonly url: URL;
  readonly path: string;
  readonly startIndex: number;
  readonly signal: AbortSignal | undefined;
}

/** Serves every child stream request the client opens through `fetch`. */
function serveChildStreams(respond: (request: ChildRequest) => Response | Promise<Response>) {
  const requests: ChildRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const request: ChildRequest = {
      path: url.pathname,
      signal: init?.signal ?? undefined,
      startIndex: Number(url.searchParams.get("startIndex") ?? 0),
      url,
    };
    requests.push(request);
    return await respond(request);
  });
  return requests;
}

/** A durable child log that honors the requested cursor, like the stream route. */
function durableChild(events: readonly MessageStreamEvent[]) {
  return (request: ChildRequest) => responseOf(events.slice(request.startIndex));
}

function createPump(options: { host?: string; onToolCompleted?: () => Promise<void> } = {}) {
  const view = fakeView();
  const pump = new SubagentPump({
    client: new Client({ host: options.host ?? "http://localhost:3000" }),
    view,
    formatActionResultError: () => "failed",
    onToolCompleted: options.onToolCompleted,
  });
  return { pump, view };
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
                nextController.error(signal.reason);
              },
              { once: true },
            );
          },
        }),
        {
          headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
        },
      );
    },
    get aborted() {
      return aborted;
    },
  };
}

function taskStarted(
  callId: string,
  turnId = "turn-1",
): TaskStartedStreamEvent & { data: { child: TaskChildStream } } {
  return {
    type: "task.started",
    data: {
      callId,
      child: {
        sessionId: `child_${callId}`,
        streamPath: `/eve/v1/children/${callId}/stream`,
      },
      kind: "agent",
      mode: "foreground",
      name: "researcher",
      taskId: `researcher-${callId}`,
      turnId,
    },
  };
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
    {
      headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
    },
  );
}

function reasoningEvent(delta: string, index = 0): MessageStreamEvent {
  return stampTestEvent(
    {
      type: "reasoning.appended",
      data: {
        reasoningDelta: delta,
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
    {
      type: "session.waiting",
      data: { continuationToken: "session-id", wait: "next-user-message" },
    } as UnstampedMessageStreamEvent,
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

function completedEvent(index: number): MessageStreamEvent {
  return stampTestEvent({ type: "session.completed" } as UnstampedMessageStreamEvent, index);
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
    const requests = serveChildStreams(({ path, signal }) => {
      const child = streams.get(path);
      if (child === undefined) throw new Error(`Unexpected child path: ${path}`);
      return child.response(signal);
    });
    const { pump, view } = createPump();

    pump.begin(taskStarted("background-a", "turn-a"), "parent");
    pump.background("background-a");
    pump.begin(taskStarted("background-b", "turn-b"), "parent");
    pump.background("background-b");
    pump.begin(taskStarted("foreground-b", "turn-b"), "parent");
    await vi.waitFor(() => expect(requests).toHaveLength(3));

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
    const requests = serveChildStreams(({ signal }) => child.response(signal));
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    child.push(reasoningEvent("**Searching for current events**", 0));
    await vi.waitFor(() =>
      expect(view.upsertStep).toHaveBeenCalledWith(
        expect.objectContaining({ callId: "call-1", finalized: false }),
      ),
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(view.upsertStep).mock.calls.length).toBe(updatesAfterSettle);

    // The parent's late `task.settled` fallback settles as a no-op.
    const completions = vi.mocked(view.complete).mock.calls.length;
    pump.settle("call-1");
    expect(vi.mocked(view.complete).mock.calls.length).toBe(completions);
  });
});

describe("SubagentPump background receipts", () => {
  it("retains a receipt that arrives before child dispatch", () => {
    const view = fakeView();
    const pump = new SubagentPump({ view, formatActionResultError: () => "failed" });
    pump.background("call-1");
    pump.begin(taskStarted("call-1"), "parent");
    pump.settleCancelledTurn("turn-1");
    expect(view.background).toHaveBeenCalledWith({ callId: "call-1" });
    expect(view.complete).not.toHaveBeenCalled();
  });

  it("keeps the section open until the child stream reaches its own boundary", async () => {
    const child = pushableChildStream();
    const requests = serveChildStreams(({ signal }) => child.response(signal));
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    pump.background("call-1");

    expect(view.background).toHaveBeenCalledWith({ callId: "call-1" });
    expect(view.complete).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    child.push(reasoningEvent("still working", 0));
    child.push(boundaryEvent(1));
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
    );

    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", reasoning: "still working" }),
    );
  });

  it("treats a child failure boundary as authoritative completion", async () => {
    serveChildStreams(durableChild([failedBoundaryEvent(0)]));
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    pump.background("call-1");

    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
    );
  });

  it("reopens after parent completion and upgrades at the child boundary", async () => {
    const child = pushableChildStream();
    const requests = serveChildStreams(({ signal }) => child.response(signal));
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    pump.settle("call-1");
    expect(view.complete).toHaveBeenCalledWith({ authoritative: false, callId: "call-1" });
    pump.begin(taskStarted("call-1"), "parent");
    expect(view.begin).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    child.push(reasoningEvent("delayed output", 0));
    child.push(boundaryEvent(1));
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenLastCalledWith({ authoritative: true, callId: "call-1" }),
    );

    expect(view.begin).toHaveBeenCalledTimes(2);
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", reasoning: "delayed output" }),
    );
  });
});

describe("SubagentPump child stream transport", () => {
  it.each([boundaryEvent(0), completedEvent(0), failedBoundaryEvent(0)])(
    "aborts a cloned open child stream at $type",
    async (boundary) => {
      const tracingError = vi.fn();
      let signal: AbortSignal | undefined;
      let closeStream = () => {};
      let tracingDone: Promise<unknown> | undefined;
      const requests = serveChildStreams((request) => {
        signal = request.signal;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              closeStream = () => controller.error(new DOMException("Aborted", "AbortError"));
              signal?.addEventListener("abort", closeStream, { once: true });
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(boundary)}\n`));
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
        );
        tracingDone = response.clone().text().catch(tracingError);
        return response;
      });
      const { pump, view } = createPump();

      try {
        pump.begin(taskStarted("call-1"), "parent");
        await vi.waitFor(() =>
          expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
        );
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        await tracingDone;

        expect(tracingError).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
        expect(requests).toHaveLength(1);
      } finally {
        closeStream();
        pump.abortAll();
        await tracingDone;
      }
    },
  );

  it("resumes from the prior cursor when a conversation subagent is called again", async () => {
    const requests = serveChildStreams(
      durableChild([
        boundaryEvent(0),
        stampTestEvent(
          {
            type: "actions.requested",
            data: {
              actions: [
                {
                  callId: "registry-add",
                  input: { address: "channel/slack" },
                  kind: "tool-call",
                  toolName: "registry_add",
                },
              ],
              sequence: 1,
              stepIndex: 0,
              turnId: "child-turn-2",
            },
          } as UnstampedMessageStreamEvent,
          1,
        ),
        stampTestEvent(
          {
            type: "action.result",
            data: {
              result: {
                callId: "registry-add",
                kind: "tool-result",
                output: { status: "needs-terminal", address: "channel/slack" },
                toolName: "registry_add",
              },
              sequence: 2,
              status: "completed",
              stepIndex: 0,
              turnId: "child-turn-2",
            },
          } as UnstampedMessageStreamEvent,
          2,
        ),
        completedEvent(3),
      ]),
    );
    const onToolCompleted = vi.fn(async () => {});
    const { pump, view } = createPump({ onToolCompleted });
    const first = taskStarted("call-1");
    first.data.child.sessionId = "conversation-child";
    first.data.name = "self-modification__agent";
    const second = taskStarted("call-2", "turn-2");
    second.data.child.sessionId = "conversation-child";
    second.data.name = "self-modification__agent";

    pump.begin(first, "parent");
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
    );
    pump.begin(second, "parent");
    await vi.waitFor(() => expect(onToolCompleted).toHaveBeenCalledOnce());

    expect(requests[1]).toMatchObject({ path: "/eve/v1/children/call-2/stream", startIndex: 1 });
    expect(onToolCompleted).toHaveBeenCalledWith("self-modification__agent", "registry_add", {
      status: "needs-terminal",
      address: "channel/slack",
    });
  });

  it("does not let a repeated call consume the previous call's trailing boundary", async () => {
    const firstStream = pushableChildStream();
    const requests = serveChildStreams((request) =>
      request.startIndex === 0
        ? firstStream.response(request.signal)
        : responseOf([reasoningEvent("second turn", 1), completedEvent(2)]),
    );
    const { pump, view } = createPump();
    const first = taskStarted("call-1");
    first.data.child.sessionId = "conversation-child";
    const second = taskStarted("call-2", "turn-2");
    second.data.child.sessionId = "conversation-child";

    pump.begin(first, "parent");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    pump.settle("call-1");
    pump.begin(second, "parent");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toHaveLength(1);

    firstStream.push(boundaryEvent(0));
    await vi.waitFor(() =>
      expect(view.upsertStep).toHaveBeenCalledWith(
        expect.objectContaining({ callId: "call-2", reasoning: "second turn" }),
      ),
    );
    expect(requests[1]).toMatchObject({ path: "/eve/v1/children/call-2/stream", startIndex: 1 });
  });

  it("leaves connection authorization events to the parent runner", async () => {
    serveChildStreams(
      durableChild([
        stampTestEvent(
          {
            type: "authorization.required",
            data: {
              description: "Authorize stub-mcp",
              name: "stub-mcp",
              sequence: 1,
              stepIndex: 0,
              turnId: "child-turn",
            },
          } as UnstampedMessageStreamEvent,
          0,
        ),
        stampTestEvent(
          {
            type: "authorization.completed",
            data: {
              name: "stub-mcp",
              outcome: "authorized",
              sequence: 2,
              stepIndex: 0,
              turnId: "child-turn",
            },
          } as UnstampedMessageStreamEvent,
          1,
        ),
        boundaryEvent(2),
      ]),
    );
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
    );

    expect(view.upsertStep).not.toHaveBeenCalled();
    expect(view.upsertTool).not.toHaveBeenCalled();
  });

  it("reopens an exhausted source at its cursor", async () => {
    vi.useFakeTimers();
    const log = [
      reasoningEvent("looked up ", 0),
      reasoningEvent("the forecast", 1),
      boundaryEvent(2),
    ];
    const requests = serveChildStreams((request) =>
      // The first connection ends after one event, before the child finishes.
      responseOf(request.startIndex === 0 ? log.slice(0, 1) : log.slice(request.startIndex)),
    );
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" }),
    );

    expect(requests.map(({ path, startIndex }) => ({ path, startIndex }))).toEqual([
      { path: "/eve/v1/children/call-1/stream", startIndex: 0 },
      { path: "/eve/v1/children/call-1/stream", startIndex: 1 },
    ]);
    expect(view.upsertStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoning: "looked up the forecast" }),
    );
  });

  it("keeps following a silent child past the default idle budget", async () => {
    vi.useFakeTimers();
    const requests = serveChildStreams((request) =>
      responseOf(requests.length > 8 ? [boundaryEvent(request.startIndex)] : []),
    );
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requests).toHaveLength(9);
    expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "call-1" });
  });

  it("stops following when the child stream is refused", async () => {
    const requests = serveChildStreams(() => new Response("forbidden", { status: 403 }));
    const { pump, view } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toHaveLength(1);
    expect(view.complete).not.toHaveBeenCalled();
    pump.settle("call-1");
    expect(view.complete).toHaveBeenCalledWith({ authoritative: false, callId: "call-1" });
  });

  it("uses the parent-authored child path and never the remote URL", async () => {
    const requests = serveChildStreams(durableChild([boundaryEvent(0)]));
    const { pump, view } = createPump({ host: "https://parent.example" });
    const called = taskStarted("remote-call");
    called.data.child.streamPath = "/eve/v1/session/parent/subagents/remote-call/child/stream";
    called.data.child.remote = { url: "https://remote.example/private" };

    pump.begin(called, "parent");
    await vi.waitFor(() =>
      expect(view.complete).toHaveBeenCalledWith({ authoritative: true, callId: "remote-call" }),
    );

    expect(requests[0]!.url.origin).toBe("https://parent.example");
    expect(requests[0]!.path).toBe(called.data.child.streamPath);
    expect(requests.map(({ url }) => url.href).join(" ")).not.toContain("remote.example");
  });

  it("ignores a task that runs no child session", () => {
    const requests = serveChildStreams(() => responseOf([]));
    const { pump, view } = createPump();
    const { child: _child, ...data } = taskStarted("workflow-call").data;

    pump.begin({ data: { ...data, kind: "workflow" }, type: "task.started" }, "parent");

    expect(view.begin).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("does not reopen after abortAll", async () => {
    vi.useFakeTimers();
    const requests = serveChildStreams(() => responseOf([]));
    const { pump } = createPump();

    pump.begin(taskStarted("call-1"), "parent");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    pump.abortAll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toHaveLength(1);
  });
});
