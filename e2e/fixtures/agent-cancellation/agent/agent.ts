import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const HITL_REQUEST = "GENERATED-PROGRAM-CHILD-HITL";
const AGENT_TASK_CANCEL = "AGENT-TASK-CANCEL";
const SLEEPER_FOLLOW_UP = "SLEEPER-FOLLOW-UP";
const CANCELLED_TURN_FOLLOW_UP = "CANCELLATION-SUBAGENT-FOLLOW-UP-OK";
/** How a call the cancelled turn stopped reads in history. */
const CANCELLED_CALL_TEXT = "cancelled before this call finished";
/** Shared with `evals/cancellation/compact-session-handoff.eval.ts`. */
const CODE_WORD = "ORCHID-42";
const CODE_WORD_QUESTION = "What is Alice's project code word?";

async function respond(request: MockModelRequest): Promise<MockModelResponse | string> {
  const message = request.lastUserMessage ?? "";
  if (message.includes(AGENT_TASK_CANCEL)) return cancelAndContinueSleeper(request);
  if (message.includes("Alice is preparing the 2026 report.")) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return "Original 2026 report";
  }
  if (message.includes("Alice corrected the report year to 2025.")) {
    return "Corrected 2025 report";
  }
  if (message.includes("Please complete work before answering.")) {
    return request.toolResults.some((result) => result.id === "complete-work")
      ? "The work item is complete."
      : { toolCalls: [{ id: "complete-work", input: {}, name: "complete-work" }] };
  }
  if (message.includes("Please wait for cancellation.")) {
    return {
      toolCalls: [{ id: "wait-for-cancellation", input: {}, name: "wait-for-cancellation" }],
    };
  }
  const markers = [...message.matchAll(/record-request with marker "([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  if (markers.length > 0) {
    const pending = markers.filter(
      (marker) => !request.toolResults.some((entry) => entry.id === `record-${marker}`),
    );
    return pending.length > 0
      ? {
          toolCalls: pending.map((marker) => ({
            id: `record-${marker}`,
            input: { marker },
            name: "record-request",
          })),
        }
      : markers
          .map((marker) =>
            String(request.toolResults.find((entry) => entry.id === `record-${marker}`)?.output),
          )
          .join("\n");
  }
  if (message.includes("call the sleeper subagent")) {
    const hitl = message.includes(HITL_REQUEST);
    // The workflow tool runs as a task: its call returns a receipt, and the
    // program's result arrives in a <task_result> message after task_wait.
    const taskResult = request.messages.find(
      (entry) => entry.role === "user" && entry.text.startsWith("<task_result"),
    );
    if (taskResult !== undefined) return taskResult.text;
    if (request.toolResults.some((entry) => entry.name === "workflow")) {
      return { toolCalls: [{ id: "wait-for-sleeper", input: {}, name: "task_wait" }] };
    }
    return {
      toolCalls: [
        {
          id: hitl ? "hitl-sleeper" : "cancel-sleeper",
          input: {
            js: hitl
              ? `return await ctx.agent("sleeper", { message: ${JSON.stringify(HITL_REQUEST)} });`
              : 'return await ctx.agent("sleeper", { message: "Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled." });',
          },
          name: "workflow",
        },
      ],
    };
  }
  if (message.includes(CANCELLED_TURN_FOLLOW_UP)) return replyAfterCancelledTurn(request);
  if (message.includes(CODE_WORD_QUESTION)) return recallCodeWord(request);
  return `Mock reply: ${message}`;
}

/** Answers only from history, so a session that lost it across compaction cannot answer. */
function recallCodeWord(request: MockModelRequest): string {
  const remembered = request.messages.some(
    (entry) => !entry.text.includes(CODE_WORD_QUESTION) && entry.text.includes(CODE_WORD),
  );
  return remembered ? CODE_WORD : "Alice's code word is not in this conversation.";
}

/**
 * Answers the follow-up to a cancelled sleeper turn only when history keeps
 * what that turn did: the sleeper call, and the calls the cancel stopped
 * answered as cancelled. Without them the sleeper request would look unanswered.
 */
function replyAfterCancelledTurn(request: MockModelRequest): string {
  const calledSleeper = request.toolResults.some((entry) => entry.id === "cancel-sleeper");
  const cancelledCall = request.toolResults.some((entry) =>
    String(entry.output).includes(CANCELLED_CALL_TEXT),
  );
  return calledSleeper && cancelledCall
    ? CANCELLED_TURN_FOLLOW_UP
    : "The cancelled turn's calls are missing from history.";
}

/**
 * Calls the sleeper agent, waits briefly for it to reach its tool, cancels
 * the task, then continues it by taskId and returns its follow-up result.
 */
function cancelAndContinueSleeper(request: MockModelRequest): MockModelResponse | string {
  const calls = (name: string) => request.toolResults.filter((entry) => entry.name === name);
  const [started, continued] = calls("sleeper");
  if (started === undefined) {
    return {
      toolCalls: [{ input: { message: "Please wait for cancellation." }, name: "sleeper" }],
    };
  }
  const taskId = /Started task (\S+)\./u.exec(String(started.output))?.[1];
  if (taskId === undefined) throw new Error("The sleeper call returned no task receipt.");
  if (calls("task_wait").length === 0) {
    return { toolCalls: [{ input: { timeoutSeconds: 2 }, name: "task_wait" }] };
  }
  if (calls("task_cancel").length === 0) {
    return { toolCalls: [{ input: { taskId }, name: "task_cancel" }] };
  }
  if (continued === undefined) {
    return { toolCalls: [{ input: { message: SLEEPER_FOLLOW_UP, taskId }, name: "sleeper" }] };
  }
  const result = [...request.messages]
    .reverse()
    .find((entry) => entry.role === "user" && entry.text.startsWith("<task_result"));
  return result?.text ?? { toolCalls: [{ input: {}, name: "task_wait" }] };
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
});
