import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
  type MockModelToolResult,
} from "eve/evals";

const TASK_ID_PATTERN = /task_[a-z0-9]+/iu;
const OBSERVED_READY_SCENARIO = "TASK-WAKE-OBSERVED-READY";
const OBSERVED_READY_FINDING = "blocker: task admission can discard deferred user input.";
const OBSERVED_READY_PROBE = "TASK-WAKE-OBSERVED-READY-PROBE";

function respond(request: MockModelRequest): MockModelResponse | string {
  // Framework agent-list notes are model context, not scenario turns.
  const message = [...request.userMessages].reverse().find(isScenarioMessage) ?? "";
  if (request.userMessages.some((entry) => entry.includes("TASK-UPDATE-PROGRESS"))) {
    return "TASK-UPDATE-RECEIVED";
  }
  if (message.includes("TASK-UPDATE-CHILD")) return sendTaskUpdate(request);
  if (message.includes("TASK-FANOUT-INTERACTIVE-CHECK")) return "TASK-FANOUT-INTERACTIVE-OK";
  if (message.includes("TASK-CANCEL-NOW")) return cancelWorkerTask(request);
  if (message.includes("CHILD-TASK-EXCLUSIVITY-RACE")) return raceBusyWorker(request);
  if (message.startsWith("CHILD-TASK-EXCLUSIVITY-LATER ")) {
    return laterBusyWorker(request, message);
  }
  if (message.startsWith("TASK-A2-CHILD-FAILURE-VERIFY ")) {
    return peekTask(request, "task-a2-child-failure-verify", "TASK-A2-FAILED", message);
  }
  if (message.startsWith("TASK-A3-UNKNOWN-VERIFY ")) {
    return peekTask(request, "task-a3-unknown-verify", "TASK-A3-UNKNOWN", message);
  }
  if (message.startsWith("TASK-D6-PARTIAL-FANOUT-VERIFY ")) {
    return peekTask(request, "task-d6-partial-fanout-verify", "TASK-D6-STATUS", message);
  }
  if (message.startsWith("TASK-D6-PARTIAL-FANOUT-UNKNOWN ")) {
    return peekTask(request, "task-d6-partial-fanout-unknown", "TASK-D6-UNKNOWN", message);
  }
  if (message.startsWith("TASK-C7-AUTHORIZATION-VERIFY ")) {
    return peekTask(request, "task-c7-authorization-verify", "TASK-C7-STATUS", message);
  }
  if (message.startsWith("TASK-C8-REMOTE-VERIFY ")) {
    return peekTask(request, "task-c8-remote-verify", "TASK-C8-STATUS", message);
  }
  if (message.includes("TASK-C8-REMOTE-CHILD")) return runRemoteGate(request);
  if (message.startsWith("Background task ")) {
    if (request.userMessages.includes(OBSERVED_READY_SCENARIO)) {
      return "TASK-OBSERVED-READY-WAKE-WAS-NOT-DROPPED";
    }
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

  if (message === "TASK-FANOUT-PARENT-UPDATES") return fanoutTasks(request, 10);
  if (message === "TASK-PARENT-WAKE-UPDATES") return fanoutTasks(request, 3);
  if (message === OBSERVED_READY_PROBE) return `${OBSERVED_READY_PROBE}-ACK`;
  if (message === OBSERVED_READY_SCENARIO) return observeReadyReviewer(request);
  if (message === "TASK-FAN-IN") return fanInTasks(request);
  if (message === "TASK-UPDATE-SETUP") return startTaskUpdateChild(request);
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
  if (message === "TASK-C7-AUTHORIZATION") {
    return startApprovalWorker(request, "task-c7-authorization-worker", "TASK-C7-STARTED");
  }
  if (message === "TASK-C8-REMOTE-HITL") return startRemoteWorker(request);
  if (message === "TASK-INPUT-BATCH-ORDERING") {
    return startApprovalWorker(request, "task-input-batch-worker", "TASK-INPUT-BATCH-STARTED");
  }
  if (message === "TASK-CONTINUATION-HITL-SETUP") {
    return startApprovalWorker(
      request,
      "task-continuation-hitl-worker",
      "TASK-CONTINUATION-HITL-READY",
    );
  }
  if (message.startsWith("TASK-CONTINUATION-HITL-SEND ")) {
    return continueApprovalWorker(request, message);
  }
  if (message === "CHILD-TASK-EXCLUSIVITY-SETUP") return setupBusyWorker(request);
  if (message === "TASK-A2-CHILD-FAILURE") return startFailingBusyWorker(request);
  if (message === "TASK-A3-DISPATCH-START-FAILURE") return startUnstartableWorker(request);
  if (message === "TASK-D6-PARTIAL-FANOUT-FAILURE") return partialFailureFanout(request);

  return `Mock reply: ${message}`;
}

function startTaskUpdateChild(request: MockModelRequest): MockModelResponse | string {
  if (resultById(request, "task-update-child") === undefined) {
    return {
      toolCalls: [
        {
          id: "task-update-child",
          input: { message: "TASK-UPDATE-CHILD" },
          name: "agent",
        },
      ],
    };
  }
  return "TASK-UPDATE-STARTED";
}

function observeReadyReviewer(request: MockModelRequest): MockModelResponse | string {
  const delegated = resultById(request, "task-observed-ready-reviewer");
  if (delegated === undefined) {
    return {
      toolCalls: [
        {
          id: "task-observed-ready-reviewer",
          input: { message: `Review PR #2277. Return this finding: ${OBSERVED_READY_FINDING}` },
          name: "busy-worker",
        },
      ],
    };
  }
  if (resultById(request, "task-observed-ready-wait-for-completion") === undefined) {
    return {
      toolCalls: [
        {
          id: "task-observed-ready-wait-for-completion",
          input: { seconds: 1 },
          name: "task_sleep",
        },
      ],
    };
  }

  const taskId = findTaskId(delegated.output);
  if (taskId === undefined) throw new Error("Observed-ready scenario has no reviewer task id.");
  const peeked = resultById(request, "task-observed-ready-peek");
  if (peeked === undefined) {
    return {
      toolCalls: [
        { id: "task-observed-ready-peek", input: { taskIds: [taskId] }, name: "task_peek" },
      ],
    };
  }
  if (!findString(peeked.output, "BUSY-WORKER:")?.includes(OBSERVED_READY_FINDING)) {
    throw new Error("The completed reviewer did not return the expected finding.");
  }
  if (resultById(request, "task-observed-ready-hold-after-peek") === undefined) {
    return {
      toolCalls: [
        {
          id: "task-observed-ready-hold-after-peek",
          input: { seconds: 1 },
          name: "task_sleep",
        },
      ],
    };
  }
  return `request changes on PR #2277.\n\n- ${OBSERVED_READY_FINDING}`;
}

function sendTaskUpdate(request: MockModelRequest): MockModelResponse | string {
  const result = resultById(request, "task-update-progress");
  if (result === undefined) {
    return {
      toolCalls: [
        {
          id: "task-update-progress",
          input: { message: "TASK-UPDATE-PROGRESS" },
          name: "task_update",
        },
      ],
    };
  }
  if (
    result.output === null ||
    typeof result.output !== "object" ||
    Reflect.get(result.output, "status") !== "sent"
  ) {
    throw new Error("task_update did not confirm delivery.");
  }
  return "TASK-UPDATE-CHILD-DONE";
}

function fanoutTasks(request: MockModelRequest, size: number): MockModelResponse | string {
  const pending = Array.from({ length: size }, (_, index) => index + 1).filter(
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
  const callId = `task-fan-in-check-${scenarioUserMessageCount(request)}`;
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
  const callId = `task-cancel-call-${scenarioUserMessageCount(request)}`;
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
              callId === "task-c7-authorization-worker"
                ? "Run the C7 authorization mode, then return C7-AUTHORIZATION-COMPLETE."
                : callId === "task-hitl-worker"
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

function startRemoteWorker(request: MockModelRequest): MockModelResponse | string {
  const callId = "task-c8-remote-worker";
  if (resultById(request, callId) === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: {
            message:
              "TASK-C8-REMOTE-CHILD Run the remote gate, then return its principal marker verbatim.",
          },
          name: "remote-loopback",
        },
      ],
    };
  }
  return "TASK-C8-STARTED";
}

function runRemoteGate(request: MockModelRequest): MockModelResponse | string {
  const callId = "task-c8-remote-gate";
  const result = resultById(request, callId);
  if (result === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: { marker: "C8" },
          name: "remote_gate",
        },
      ],
    };
  }
  const marker = findString(result.output, "C8-REMOTE-PRINCIPAL:");
  if (marker === undefined) throw new Error("Remote gate returned no principal marker.");
  return `C8-REMOTE-COMPLETE ${marker}`;
}

function peekTask(
  request: MockModelRequest,
  callIdPrefix: string,
  completedText: string,
  message: string,
): MockModelResponse | string {
  const callId = `${callIdPrefix}-${scenarioUserMessageCount(request)}`;
  if (resultById(request, callId) === undefined) {
    const taskId = TASK_ID_PATTERN.exec(message)?.[0];
    if (taskId === undefined) throw new Error(`Verification message has no task id: ${message}`);
    return { toolCalls: [{ id: callId, input: { taskIds: [taskId] }, name: "task_peek" }] };
  }
  return completedText;
}

function isScenarioMessage(message: string): boolean {
  return !message.startsWith("[Agents]");
}

function scenarioUserMessageCount(request: MockModelRequest): number {
  return request.userMessages.filter(isScenarioMessage).length;
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

function startFailingBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const callId = "task-a2-failing-busy-worker";
  if (resultById(request, callId) === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: { message: "TASK-A2-BUSY-WORKER-FAILURE" },
          name: "busy-worker",
        },
      ],
    };
  }
  return "TASK-A2-CHILD-FAILURE-STARTED";
}

function startUnstartableWorker(request: MockModelRequest): MockModelResponse | string {
  const callId = "task-a3-unstartable-worker";
  if (resultById(request, callId) === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: { message: "TASK-A3-INTENTIONAL-START-FAILURE" },
          name: "unstartable-worker",
        },
      ],
    };
  }
  return "TASK-A3-PARENT-SURVIVED";
}

const PARTIAL_FANOUT_CALLS = [
  {
    id: "task-d6-success-first",
    message: "TASK-D6-FIRST-SUCCESS",
    name: "busy-worker",
  },
  {
    id: "task-d6-failure-middle",
    message: "TASK-D6-INTENTIONAL-START-FAILURE",
    name: "unstartable-worker",
  },
  {
    id: "task-d6-success-third",
    message: "TASK-D6-THIRD-SUCCESS",
    name: "busy-worker",
  },
] as const;

function partialFailureFanout(request: MockModelRequest): MockModelResponse | string {
  const pending = PARTIAL_FANOUT_CALLS.filter(({ id }) => resultById(request, id) === undefined);
  if (pending.length > 0) {
    return {
      toolCalls: pending.map(({ id, message, name }) => ({
        id,
        input: { message },
        name,
      })),
    };
  }
  return "TASK-D6-PARTIAL-FANOUT-STARTED";
}

function raceBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const first = resultById(request, "child-task-exclusivity-send-a");
  const second = resultById(request, "child-task-exclusivity-send-b");
  if (first === undefined && second === undefined) {
    const initial = resultById(request, "child-task-exclusivity-initial-worker");
    const agentId = findAgentId(initial?.output);
    if (agentId === undefined) throw new Error("Busy-worker race has no initial agent id.");
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-send-a",
          input: { agentId, message: "Return BUSY-WORKER-A." },
          name: "busy-worker",
        },
        {
          id: "child-task-exclusivity-send-b",
          input: { agentId, message: "Return BUSY-WORKER-B." },
          name: "busy-worker",
        },
      ],
    };
  }
  return "CHILD-TASK-EXCLUSIVITY-RACE-DONE";
}

function laterBusyWorker(request: MockModelRequest, message: string): MockModelResponse | string {
  const result = resultById(request, "child-task-exclusivity-later");
  if (result === undefined) {
    const agentId = findAgentId(message);
    if (agentId === undefined) throw new Error("Later exclusivity continuation has no agent id.");
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-later",
          input: { agentId, message: "Return BUSY-WORKER-LATER." },
          name: "busy-worker",
        },
      ],
    };
  }
  return "CHILD-TASK-EXCLUSIVITY-LATER-DONE";
}

function continueApprovalWorker(
  request: MockModelRequest,
  message: string,
): MockModelResponse | string {
  const callId = "task-continuation-hitl-send";
  const result = resultById(request, callId);
  if (result === undefined) {
    const agentId = findAgentId(message);
    if (agentId === undefined) throw new Error("Continuation HITL has no agent id.");
    return {
      toolCalls: [
        {
          id: callId,
          input: {
            message:
              "Run four continuation approval gates in order, then return CHILD-GATES-COMPLETE.",
            agentId,
          },
          name: "approval-worker",
        },
      ],
    };
  }
  return "TASK-CONTINUATION-HITL-STARTED";
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

function findAgentId(value: unknown): string | undefined {
  if (typeof value === "string") return /ag_[^\s<>]+/u.exec(value)?.[0];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const agentId = findAgentId(entry);
      if (agentId !== undefined) return agentId;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const agentId = Reflect.get(value, "agentId");
    if (typeof agentId === "string") return agentId;
    for (const entry of Object.values(value)) {
      const nested = findAgentId(entry);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function findString(value: unknown, prefix: string): string | undefined {
  if (typeof value === "string") return value.startsWith(prefix) ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findString(entry, prefix);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const match = findString(entry, prefix);
      if (match !== undefined) return match;
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
