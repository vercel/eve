import type { MessageStreamEvent, InputRequest } from "eve/client";
import type { Session } from "eve/channels";
import { terminal, type Task, type TaskState } from "./protocol";

export interface Projection {
  task: Task;
  pending: readonly InputRequest[];
  cursor: number;
  activeCalls: Set<string>;
  turnId?: string;
}

export function initial(id: string): Projection {
  return {
    task: { id, contextId: id, status: { state: "TASK_STATE_SUBMITTED" } },
    pending: [],
    cursor: 0,
    activeCalls: new Set(),
  };
}

export function applyEvent(view: Projection, event: MessageStreamEvent): void {
  view.cursor += 1;
  if (terminal(view.task)) return;
  const setState = (state: TaskState, message?: unknown) => {
    view.task.status = {
      state,
      timestamp: event.meta.at,
      message,
    };
  };
  switch (event.type) {
    case "actions.requested":
      for (const action of event.data.actions) view.activeCalls.add(action.callId);
      break;
    case "action.result":
      view.activeCalls.delete(event.data.result.callId);
      // Workflow answers in 0.52.2 can settle the owning tool without input.resolved.
      view.pending = view.pending.filter(
        (request) => request.action?.callId !== event.data.result.callId,
      );
      if (view.pending.length === 0 && view.task.status.state === "TASK_STATE_INPUT_REQUIRED")
        setState("TASK_STATE_WORKING");
      break;
    case "turn.started":
      view.turnId = event.data.turnId;
      setState("TASK_STATE_WORKING");
      break;
    case "input.requested":
      view.pending = event.data.requests;
      setState("TASK_STATE_INPUT_REQUIRED", {
        messageId: event.meta.id,
        role: "ROLE_AGENT",
        taskId: view.task.id,
        contextId: view.task.contextId,
        parts: [{ text: event.data.requests.map((request) => request.prompt).join("\n") }],
      });
      break;
    case "input.resolved":
      view.pending = view.pending.filter(
        (request) => !event.data.resolutions.some((r) => r.requestId === request.requestId),
      );
      if (view.pending.length === 0) setState("TASK_STATE_WORKING");
      break;
    case "authorization.required":
      setState("TASK_STATE_AUTH_REQUIRED");
      break;
    case "authorization.completed":
      setState("TASK_STATE_WORKING");
      break;
    case "message.completed":
      if (event.data.finishReason !== "tool-calls" && event.data.message !== null) {
        view.task.artifacts = [{ artifactId: "result", parts: [{ text: event.data.message }] }];
      }
      break;
    case "result.completed":
      view.task.artifacts = [{ artifactId: "result", parts: [{ data: event.data.result }] }];
      break;
    case "turn.completed":
      // In eve 0.52.2 a parked workflow can emit turn.completed with its tool still pending.
      if (view.activeCalls.size === 0 && view.pending.length === 0)
        setState("TASK_STATE_COMPLETED");
      break;
    case "turn.cancelled":
      setState("TASK_STATE_CANCELED");
      break;
    case "turn.failed":
    case "session.failed":
      setState("TASK_STATE_FAILED", {
        messageId: event.meta.id,
        role: "ROLE_AGENT",
        taskId: view.task.id,
        contextId: view.task.contextId,
        parts: [{ text: "Agent execution failed" }],
      });
      break;
  }
}

export async function snapshot(session: Session, id: string): Promise<Projection> {
  const view = initial(id);
  const tail = await session.getStreamTailIndex();
  if (tail < 0) return view;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  try {
    while (view.cursor <= tail) {
      const { done, value } = await reader.read();
      if (done) break;
      applyEvent(view, value);
    }
    return view;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function waitForState(
  session: Session,
  view: Projection,
  ready: (task: Task) => boolean,
  signal: AbortSignal,
): Promise<Projection> {
  if (ready(view.task)) return view;
  const reader = (await session.getEventStream({ startIndex: view.cursor })).getReader();
  const cancel = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (!ready(view.task)) {
      const { done, value } = await reader.read();
      if (done) break;
      applyEvent(view, value);
    }
    signal.throwIfAborted();
    if (!ready(view.task)) throw new Error("Session stream ended before the expected task state");
    return view;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
    reader.releaseLock();
  }
}

export function streamTask(session: Session, view: Projection, id: string | number): Response {
  let reader: ReadableStreamDefaultReader<MessageStreamEvent> | undefined;
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (result: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`),
        );
      try {
        send({ task: view.task });
        reader = (await session.getEventStream({ startIndex: view.cursor })).getReader();
        if (cancelled) {
          await reader.cancel();
          return;
        }
        while (!terminal(view.task)) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          const previousStatus = JSON.stringify(view.task.status);
          const previousArtifacts = JSON.stringify(view.task.artifacts);
          applyEvent(view, value);
          if (previousArtifacts !== JSON.stringify(view.task.artifacts)) {
            for (const artifact of view.task.artifacts ?? [])
              send({
                artifactUpdate: {
                  taskId: view.task.id,
                  contextId: view.task.contextId,
                  artifact,
                  append: false,
                  lastChunk: true,
                },
              });
          }
          if (previousStatus !== JSON.stringify(view.task.status))
            send({
              statusUpdate: {
                taskId: view.task.id,
                contextId: view.task.contextId,
                status: view.task.status,
              },
            });
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        await reader?.cancel();
        reader?.releaseLock();
      }
    },
    async cancel() {
      cancelled = true;
      await reader?.cancel();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
