import type { SessionStreamEvent } from "eve/client";
import type { CallOutcome } from "eve/events";
import { taskCompletionOutputSchema } from "@agent/subagents/browser-agent/lib/completion";

const browserWorkerTool = "run_browser";

type BrowserWorkerCallStatus = "cancelled" | "completed" | "failed";

interface BrowserWorkerCallState {
  output?: unknown;
  status?: BrowserWorkerCallStatus;
  taskId?: string;
  terminalAt?: string;
}

export function measureWorkerTask(
  events: readonly SessionStreamEvent[],
  fallbackDurationMs: number
) {
  const start = events.find((event) => event.type === "delivery.consumed")?.meta
    .at;
  const workerCalls = readBrowserWorkerCalls(events);
  const pendingWorker = workerCalls.some((call) => call.status === undefined);
  const terminal =
    readTaskCompletion(events)?.completedAt ??
    (pendingWorker
      ? undefined
      : workerCalls.findLast((call) => call.terminalAt)?.terminalAt) ??
    events.findLast(
      (event) =>
        (event.type === "session.ended" && event.data.outcome === "failed") ||
        (!pendingWorker &&
          event.type === "turn.settled" &&
          event.data.outcome !== "completed")
    )?.meta.at;
  let modelSteps = 0;
  let measuredSteps = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    if (event.type !== "usage.recorded" || event.data.kind !== "model") {
      continue;
    }
    modelSteps += 1;
    const { usage } = event.data;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) {
      measuredSteps += 1;
      costUsd += usage.costUsd;
    }
  }

  return {
    costComplete: modelSteps > 0 && measuredSteps === modelSteps,
    costUsd: measuredSteps === 0 ? null : costUsd,
    durationMs:
      start && terminal
        ? elapsedMs(start, terminal)
        : Math.max(0, fallbackDurationMs),
    inputTokens: modelSteps === 0 ? null : inputTokens,
    modelSteps,
    outputTokens: modelSteps === 0 ? null : outputTokens,
  };
}

export function didCompleteWorker(events: readonly SessionStreamEvent[]) {
  return readTaskCompletion(events)?.status === "success";
}

export function didFinishWorker(events: readonly SessionStreamEvent[]) {
  const workerCalls = readBrowserWorkerCalls(events);
  if (workerCalls.length > 0) {
    return workerCalls.every((call) => call.status !== undefined);
  }
  return readTaskCompletion(events) !== undefined;
}

export function terminalWorkerMessage(
  message: string | undefined,
  events: readonly SessionStreamEvent[]
) {
  const completion = readTaskCompletion(events);
  if (completion) return normalizeMessage(completion.message);

  if (message?.trim()) return normalizeMessage(message);

  const failure = events.findLast(
    (event) =>
      (event.type === "turn.settled" || event.type === "session.ended") &&
      event.data.outcome === "failed"
  );
  const failureMessage =
    failure?.type === "turn.settled" || failure?.type === "session.ended"
      ? failure.data.error?.message
      : undefined;

  return failure
    ? normalizeMessage(failureMessage ?? "The worker failed.")
    : "No terminal message";
}

/**
 * Reads the browser worker's structured completion. A root session reports it
 * as the settled output of its `run_browser` calls; the worker's own session
 * reports it as a `result` content part.
 */
export function readTaskCompletion(events: readonly SessionStreamEvent[]) {
  const workerCalls = readBrowserWorkerCalls(events);
  if (workerCalls.length > 0) {
    if (workerCalls.some((call) => call.status === undefined)) {
      return undefined;
    }

    const latest = workerCalls.at(-1);
    if (latest?.status === "completed" && latest.terminalAt) {
      const completion = taskCompletionOutputSchema.safeParse(latest.output);
      if (completion.success) {
        return { ...completion.data, completedAt: latest.terminalAt };
      }
    }
    return undefined;
  }

  for (const event of events.toReversed()) {
    if (event.type !== "content.completed" || event.data.kind !== "result") {
      continue;
    }
    const completion = taskCompletionOutputSchema.safeParse(event.data.value);
    if (completion.success) {
      return { ...completion.data, completedAt: event.meta.at };
    }
  }

  return undefined;
}

function readBrowserWorkerCalls(events: readonly SessionStreamEvent[]) {
  const calls = new Map<string, BrowserWorkerCallState>();

  for (const event of events) {
    switch (event.type) {
      case "call.requested":
        if (
          event.data.capability.kind === "tool" &&
          event.data.capability.name === browserWorkerTool
        ) {
          calls.set(event.data.callId, {});
        }
        break;
      case "call.started": {
        const call = calls.get(event.data.callId);
        if (call && event.data.taskId) call.taskId = event.data.taskId;
        break;
      }
      case "call.settled": {
        const call = calls.get(event.data.callId);
        if (!call || call.status) break;
        call.output = event.data.output;
        call.status = callStatus(event.data.outcome);
        call.terminalAt = event.meta.at;
        break;
      }
      case "task.ended":
        // eve__task_cancel ends the task before its call can reply.
        for (const call of calls.values()) {
          if (call.taskId !== event.data.taskId || call.status) continue;
          call.status = event.data.outcome;
          call.terminalAt = event.meta.at;
        }
        break;
      default:
        break;
    }
  }

  return [...calls.values()];
}

function callStatus(outcome: CallOutcome): BrowserWorkerCallStatus {
  switch (outcome) {
    case "completed":
      return "completed";
    case "interrupted":
    case "abandoned":
      return "cancelled";
    default:
      return "failed";
  }
}

function elapsedMs(start: string, end: string) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function normalizeMessage(message: string) {
  return message.replaceAll(/\s+/gu, " ").trim();
}
