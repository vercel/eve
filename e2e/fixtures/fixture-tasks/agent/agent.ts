import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
  type MockModelToolResult,
} from "eve/evals";

const TASK_ID_PATTERN = /task_[a-z0-9]+/iu;

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("TASK-FANOUT-INTERACTIVE-CHECK")) return "TASK-FANOUT-INTERACTIVE-OK";
  if (message.includes("TASK-CANCEL-NOW")) return cancelWorkerTask(request);
  if (message.includes("CHILD-TASK-EXCLUSIVITY-RACE")) return raceBusyWorker(request);
  if (message.startsWith("CHILD-TASK-EXCLUSIVITY-LATER ")) {
    return laterBusyWorker(request, message);
  }
  if (message.startsWith("Background task ")) {
    // Scenarios that act on wake notifications route to their script;
    // every other scenario acknowledges them without running tools.
    // The exclusivity race delegates so a completion notification that
    // coalesces into the RACE turn still runs the same-batch sends.
    if (request.userMessages.includes("TASK-FAN-IN")) return fanInNotification(request);
    if (request.userMessages.includes("CHILD-TASK-EXCLUSIVITY-RACE")) {
      return raceBusyWorker(request);
    }
    return "TASK-NOTIFICATION-ACK";
  }

  if (message === "TASK-FANOUT-PARENT-UPDATES") return fanoutTasks(request);
  if (message === "TASK-FAN-IN") return fanInTasks(request);
  if (message === "TASK-CANCEL-SETUP") return setupCancelWorker(request);
  if (message.startsWith("TASK-CANCEL-VERIFY ")) {
    return peekTask(request, "task-cancel-verify", "TASK-CANCEL-STATUS", message);
  }

  if (message.startsWith("TASK-HITL-VERIFY ")) {
    return peekTask(request, "task-hitl-verify", "TASK-HITL-STATUS", message);
  }
  if (message.startsWith("TASK-INPUT-BATCH-VERIFY ")) {
    return peekTask(request, "task-input-batch-verify", "TASK-INPUT-BATCH-STATUS", message);
  }
  if (message.startsWith("CHILD-TASK-EXCLUSIVITY-VERIFY ")) {
    return peekTask(
      request,
      "child-task-exclusivity-verify",
      "CHILD-TASK-EXCLUSIVITY-STATUS",
      message,
    );
  }
  if (message === "TASK-HITL-ROUTING") {
    return startApprovalWorker(request, "task-hitl-worker", "TASK-HITL-STARTED");
  }
  if (message === "TASK-INPUT-BATCH-ORDERING") {
    return startApprovalWorker(request, "task-input-batch-worker", "TASK-INPUT-BATCH-STARTED");
  }
  if (message === "CHILD-TASK-EXCLUSIVITY-SETUP") return setupBusyWorker(request);

  return `Mock reply: ${message}`;
}

function fanoutTasks(request: MockModelRequest): MockModelResponse | string {
  const pending = Array.from({ length: 10 }, (_, index) => index + 1).filter(
    (index) => resultById(request, `task-fanout-${index}`) === undefined,
  );
  if (pending.length > 0) {
    return {
      toolCalls: pending.map((index) => ({
        id: `task-fanout-${index}`,
        input: { message: `FANOUT-WORKER-${index}` },
        name: "fanout-worker",
      })),
    };
  }
  return "TASK-FANOUT-STARTED";
}

const FAN_IN_CALL_IDS = ["task-fan-in-1", "task-fan-in-2"] as const;

function fanInTasks(request: MockModelRequest): MockModelResponse | string {
  const pending = FAN_IN_CALL_IDS.filter((id) => resultById(request, id) === undefined);
  if (pending.length > 0) {
    return {
      toolCalls: pending.map((id) => ({
        id,
        input: { message: `Run the release gate, then return ${id.toUpperCase()}.` },
        name: "fanout-worker",
      })),
    };
  }
  return "TASK-FAN-IN-STARTED";
}

/**
 * The deterministic join predicate: on every wake, peek every fan-in task
 * and answer only when all of them are completed. This is the model-side
 * join contract — the framework delivers one wake
 * per ready transition and the model decides whether the state suffices.
 */
function fanInNotification(request: MockModelRequest): MockModelResponse | string {
  const callId = `task-fan-in-check-${request.userMessageCount}`;
  const checked = resultById(request, callId);
  const taskIds = FAN_IN_CALL_IDS.map((id) => findTaskId(resultById(request, id)?.output)).filter(
    (taskId): taskId is string => taskId !== undefined,
  );
  if (taskIds.length !== FAN_IN_CALL_IDS.length) {
    throw new Error("Fan-in notification arrived before both task receipts.");
  }
  if (checked === undefined) {
    return { toolCalls: [{ id: callId, input: { taskIds }, name: "task_peek" }] };
  }
  return allTasksCompleted(checked.output, taskIds)
    ? "TASK-FAN-IN-COMPLETE"
    : "TASK-FAN-IN-WAITING";
}

function allTasksCompleted(output: unknown, expectedTaskIds: readonly string[]): boolean {
  if (output === null || typeof output !== "object") return false;
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks) || tasks.length !== expectedTaskIds.length) return false;
  const byId = new Map(
    tasks
      .filter((task) => task !== null && typeof task === "object")
      .map((task) => [Reflect.get(task, "taskId"), task] as const),
  );
  return expectedTaskIds.every(
    (taskId) => Reflect.get(byId.get(taskId) ?? {}, "status") === "completed",
  );
}

function setupCancelWorker(request: MockModelRequest): MockModelResponse | string {
  if (resultById(request, "task-cancel-worker") === undefined) {
    return {
      toolCalls: [
        {
          id: "task-cancel-worker",
          input: { message: "Run the release gate, then return CANCEL-WORKER-DONE." },
          name: "fanout-worker",
        },
      ],
    };
  }
  return "TASK-CANCEL-READY";
}

function cancelWorkerTask(request: MockModelRequest): MockModelResponse | string {
  const callId = `task-cancel-call-${request.userMessageCount}`;
  if (resultById(request, callId) === undefined) {
    const taskId = findTaskId(resultById(request, "task-cancel-worker")?.output);
    if (taskId === undefined) throw new Error("Cancel scenario has no initial task id.");
    return { toolCalls: [{ id: callId, input: { taskIds: [taskId] }, name: "task_cancel" }] };
  }
  return "TASK-CANCEL-DONE";
}

function startApprovalWorker(
  request: MockModelRequest,
  callId: string,
  completedText: string,
): MockModelResponse | string {
  if (resultById(request, callId) === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: {
            message:
              callId === "task-hitl-worker"
                ? "Run three approval gates in order, then return CHILD-GATES-COMPLETE."
                : "Run both approval gates in order, then return CHILD-GATES-COMPLETE.",
          },
          name: "approval-worker",
        },
      ],
    };
  }
  return completedText;
}

function peekTask(
  request: MockModelRequest,
  callIdPrefix: string,
  completedText: string,
  message: string,
): MockModelResponse | string {
  const callId = `${callIdPrefix}-${request.userMessageCount}`;
  if (resultById(request, callId) === undefined) {
    const taskId = TASK_ID_PATTERN.exec(message)?.[0];
    if (taskId === undefined) throw new Error(`Verification message has no task id: ${message}`);
    return { toolCalls: [{ id: callId, input: { taskIds: [taskId] }, name: "task_peek" }] };
  }
  return completedText;
}

function setupBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const delegated = resultById(request, "child-task-exclusivity-initial-worker");
  if (delegated === undefined) {
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-initial-worker",
          input: { message: "Return BUSY-WORKER-INITIAL." },
          name: "busy-worker",
        },
      ],
    };
  }

  return "CHILD-TASK-EXCLUSIVITY-READY";
}

function raceBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const first = resultById(request, "child-task-exclusivity-send-a");
  const second = resultById(request, "child-task-exclusivity-send-b");
  if (first === undefined && second === undefined) {
    const initial = resultById(request, "child-task-exclusivity-initial-worker");
    const taskId = findTaskId(initial?.output);
    if (taskId === undefined) throw new Error("Busy-worker race has no initial task id.");
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-send-a",
          input: { message: "Return BUSY-WORKER-A.", taskId },
          name: "task_send",
        },
        {
          id: "child-task-exclusivity-send-b",
          input: { message: "Return BUSY-WORKER-B.", taskId },
          name: "task_send",
        },
      ],
    };
  }
  return "CHILD-TASK-EXCLUSIVITY-RACE-DONE";
}

function laterBusyWorker(request: MockModelRequest, message: string): MockModelResponse | string {
  const result = resultById(request, "child-task-exclusivity-later");
  if (result === undefined) {
    const taskId = findTaskId(message);
    if (taskId === undefined) throw new Error("Later exclusivity send has no task id.");
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-later",
          input: { message: "Return BUSY-WORKER-LATER.", taskId },
          name: "task_send",
        },
      ],
    };
  }
  return "CHILD-TASK-EXCLUSIVITY-LATER-DONE";
}

function resultById(request: MockModelRequest, id: string): MockModelToolResult | undefined {
  return request.toolResults.find((result) => result.id === id);
}

function findTaskId(value: unknown): string | undefined {
  if (typeof value === "string") return TASK_ID_PATTERN.exec(value)?.[0];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const taskId = findTaskId(entry);
      if (taskId !== undefined) return taskId;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const taskId = Reflect.get(value, "taskId");
    if (typeof taskId === "string") return taskId;
    for (const entry of Object.values(value)) {
      const nested = findTaskId(entry);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, tasks: true },
  // These evals target orchestration, not model planning. Keep every suite
  // deterministic while retaining the workflow-world override from `base`.
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
