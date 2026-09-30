import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type MessageStreamEvent } from "#client/index.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  type AgentStartedStreamEvent,
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
    end: vi.fn(),
    upsertStep: vi.fn(),
    upsertTool: vi.fn(),
    removeTool: vi.fn(),
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

interface AgentTaskOptions {
  readonly name?: string;
  readonly remote?: AgentStartedStreamEvent["data"]["remote"];
  readonly sessionId?: string;
  readonly streamPath?: string;
  readonly turnId?: string;
}

/** Starts an agent task the way the parent stream announces it: the call, then its session. */
function startAgentTask(
  pump: SubagentPump,
  callId: string,
  options: AgentTaskOptions = {},
): { readonly name: string; readonly taskId: string } {
  const name = options.name ?? "researcher";
  const taskId = `${name}-${callId}`;
  const turnId = options.turnId ?? "turn-1";
  callAgentTask(pump, { name, taskId }, callId, turnId);
  const data: AgentStartedStreamEvent["data"] = {
    callId,
    name,
    sessionId: options.sessionId ?? `child_${callId}`,
    streamPath: options.streamPath ?? `/eve/v1/children/${callId}/stream`,
    taskId,
    turnId,
  };
  if (options.remote !== undefined) data.remote = options.remote;
  pump.agentStarted({ data, type: "agent.started" }, "parent");
  return { name, taskId };
}

/** A later call to a task reaches the session the task already opened. */
function callAgentTask(
  pump: SubagentPump,
  task: { readonly name: string; readonly taskId: string },
  callId: string,
  turnId = "turn-1",
): void {
  pump.taskStarted(
    {
      data: { callId, kind: "agent", name: task.name, taskId: task.taskId, turnId },
      type: "task.started",
    },
    "parent",
  );
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
  it("cancels only descendants of the exact turn", async () => {
    const childA = pushableChildStream();
    const childB = pushableChildStream();
    const streams = new Map([
      ["/eve/v1/children/child-a/stream", childA],
      ["/eve/v1/children/child-b/stream", childB],
    ]);
    const requests = serveChildStreams(({ path, signal }) => {
      const child = streams.get(path);
      if (child === undefined) throw new Error(`Unexpected child path: ${path}`);
      return child.response(signal);
    });
    const { pump } = createPump();

    startAgentTask(pump, "child-a", { turnId: "turn-a" });
    startAgentTask(pump, "child-b", { turnId: "turn-b" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    pump.settleCancelledTurn("turn-b");

    expect(childB.aborted).toBe(true);
    expect(childA.aborted).toBe(false);
    pump.abortAll();
  });

  it("finalizes the live step and stops stale child output after cancellation", async () => {
    const child = pushableChildStream();
    const requests = serveChildStreams(({ signal }) => child.response(signal));
    const { pump, view } = createPump();

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    child.push(reasoningEvent("**Searching for current events**", 0));
    await vi.waitFor(() =>
      expect(view.upsertStep).toHaveBeenCalledWith(
        expect.objectContaining({ callId: "call-1", finalized: false }),
      ),
    );

    // The parent turn is cancelled: the live step finalizes and the stream stops.
    pump.settleCancelledTurn("turn-1");
    expect(view.upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", finalized: true }),
    );

    // A child still flushing output after the cancel paints nothing.
    const updatesAfterSettle = vi.mocked(view.upsertStep).mock.calls.length;
    child.push(reasoningEvent("stale output", 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(view.upsertStep).mock.calls.length).toBe(updatesAfterSettle);
  });
});

describe("SubagentPump task bookkeeping", () => {
  it("keeps the child's task bookkeeping out of its activity", async () => {
    const action = (callId: string, toolName: string) => ({
      callId,
      input: toolName === "task_wait" ? {} : { message: "Check the filings" },
      kind: "tool-call" as const,
      toolName,
    });
    const result = (callId: string, toolName: string, output: unknown, status = "completed") => ({
      type: "action.result",
      data: {
        result: { callId, kind: "tool-result", output, toolName },
        sequence: 2,
        status,
        stepIndex: 0,
        turnId: "child-turn",
      },
    });
    serveChildStreams(
      durableChild(
        [
          {
            type: "actions.requested",
            data: {
              actions: [
                action("analyst-call", "analyst"),
                action("deploy-call", "deploy"),
                action("wait-call", "task_wait"),
              ],
              sequence: 1,
              stepIndex: 0,
              turnId: "child-turn",
            },
          },
          {
            type: "task.started",
            data: {
              callId: "analyst-call",
              kind: "agent",
              name: "analyst",
              taskId: "t1",
              turnId: "child-turn",
            },
          },
          result("analyst-call", "analyst", "model-facing receipt"),
          result("deploy-call", "deploy", { code: "TOO_MANY_TASKS", message: "wait" }, "failed"),
          result("wait-call", "task_wait", "t1 completed; its result follows."),
          {
            type: "task.settled",
            data: {
              callId: "analyst-call",
              output: "Revenue grew 12%",
              status: "completed",
              taskId: "t1",
              turnId: "child-turn",
            },
          },
          { type: "session.waiting", data: { continuationToken: "c", wait: "next-user-message" } },
        ].map((event, index) => stampTestEvent(event as UnstampedMessageStreamEvent, index)),
      ),
    );
    const { pump, view } = createPump();

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(view.removeTool).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(view.upsertTool).toHaveBeenLastCalledWith(
        expect.objectContaining({ childCallId: "analyst-call", status: "done" }),
      ),
    );

    const updates = vi.mocked(view.upsertTool).mock.calls.map(([update]) => update);
    expect(updates.some((update) => update.toolName === "task_wait")).toBe(false);
    // The agent call reads as a delegation and ends with its task, not its receipt.
    expect(
      updates
        .filter((update) => update.childCallId === "analyst-call")
        .map(({ status, agentTask, output }) => ({ status, agentTask, output })),
    ).toEqual([
      { status: "executing", agentTask: undefined, output: undefined },
      { status: "executing", agentTask: true, output: undefined },
      { status: "done", agentTask: true, output: "Revenue grew 12%" },
    ]);
    // A call refused for the model to retry leaves the activity, with why.
    expect(view.removeTool).toHaveBeenCalledWith({
      callId: "call-1",
      childCallId: "deploy-call",
      reason: "failed",
    });
    // The task's end waits for the child's own boundary, which it reached.
    expect(view.begin).toHaveBeenCalledWith({ callId: "call-1" });
    await vi.waitFor(() => expect(view.end).toHaveBeenCalledWith({ callId: "call-1" }));
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
      const { pump } = createPump();

      try {
        startAgentTask(pump, "call-1");
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
    const { pump } = createPump({ onToolCompleted });
    const task = startAgentTask(pump, "call-1", {
      name: "self-modification__agent",
      sessionId: "conversation-child",
    });
    await vi.waitFor(() => expect(requests[0]?.signal?.aborted).toBe(true));
    callAgentTask(pump, task, "call-2", "turn-2");
    await vi.waitFor(() => expect(onToolCompleted).toHaveBeenCalledOnce());

    expect(requests[1]).toMatchObject({ path: "/eve/v1/children/call-1/stream", startIndex: 1 });
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
    const task = startAgentTask(pump, "call-1", { sessionId: "conversation-child" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    callAgentTask(pump, task, "call-2", "turn-2");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toHaveLength(1);

    firstStream.push(boundaryEvent(0));
    await vi.waitFor(() =>
      expect(view.upsertStep).toHaveBeenCalledWith(
        expect.objectContaining({ callId: "call-2", reasoning: "second turn" }),
      ),
    );
    expect(requests[1]).toMatchObject({ path: "/eve/v1/children/call-1/stream", startIndex: 1 });
  });

  it("leaves connection authorization events to the parent runner", async () => {
    const authRequests = serveChildStreams(
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

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(authRequests[0]?.signal?.aborted).toBe(true));

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

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(requests[1]?.signal?.aborted).toBe(true));

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
    const { pump } = createPump();

    startAgentTask(pump, "call-1");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requests).toHaveLength(9);
    expect(requests.at(-1)?.signal?.aborted).toBe(true);
  });

  it("stops following when the child stream is refused", async () => {
    const requests = serveChildStreams(() => new Response("forbidden", { status: 403 }));
    const { pump, view } = createPump();

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toHaveLength(1);
    // Nothing more will come, so the task's end must not wait for it.
    expect(view.end).toHaveBeenCalledWith({ callId: "call-1" });
  });

  it("uses the parent-authored child path and never the remote URL", async () => {
    const requests = serveChildStreams(durableChild([boundaryEvent(0)]));
    const { pump } = createPump({ host: "https://parent.example" });
    const streamPath = "/eve/v1/session/parent/subagents/remote-call/child/stream";
    startAgentTask(pump, "remote-call", {
      remote: { url: "https://remote.example/private" },
      streamPath,
    });
    await vi.waitFor(() => expect(requests[0]?.signal?.aborted).toBe(true));

    expect(requests[0]!.url.origin).toBe("https://parent.example");
    expect(requests[0]!.path).toBe(streamPath);
    expect(requests.map(({ url }) => url.href).join(" ")).not.toContain("remote.example");
  });

  it("does not reopen after abortAll", async () => {
    vi.useFakeTimers();
    const requests = serveChildStreams(() => responseOf([]));
    const { pump } = createPump();

    startAgentTask(pump, "call-1");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    pump.abortAll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toHaveLength(1);
  });
});
