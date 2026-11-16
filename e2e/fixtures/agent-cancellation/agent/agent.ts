import { e2eAgentConfig } from "@eve-e2e/config";
import { playScript, programResultOf, runProgram } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

/** Starts the evals whose scripted parent asks the sleeper agent from an `eve__execute` program. */
const PROGRAM_SLEEPER_REQUEST = "ask the sleeper agent from one program";
/** What the program sends the sleeper to make it ask a question; shared with the sleeper. */
const CHILD_QUESTION_REQUEST = "PROGRAM-CHILD-QUESTION";
const WAIT_FOR_CANCELLATION_REQUEST =
  "Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled.";
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
  if (message.includes(AGENT_TASK_CANCEL)) return cancelAndRestartSleeper(request);
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
  if (message.includes(PROGRAM_SLEEPER_REQUEST)) {
    const question = message.includes(CHILD_QUESTION_REQUEST);
    const id = question ? "question-sleeper" : "cancel-sleeper";
    const code = `return await tools.sleeper({ message: ${JSON.stringify(
      question ? CHILD_QUESTION_REQUEST : WAIT_FOR_CANCELLATION_REQUEST,
    )} });`;
    // The program's call holds the turn until the sleeper replies, so its result is the call's own.
    return playScript(request, [runProgram(id, code)], (finished) =>
      String(programResultOf(finished, id)),
    );
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
 * what that turn did: the `eve__execute` call that ran the sleeper's program,
 * answered as cancelled. Without it the sleeper request would look unanswered.
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
 * the task, then starts a fresh task and returns its reply without the cancelled task's history.
 */
function cancelAndRestartSleeper(request: MockModelRequest): MockModelResponse | string {
  const calls = (name: string) => request.toolResults.filter((entry) => entry.name === name);
  const [started, restarted] = calls("sleeper");
  if (started === undefined) {
    return {
      toolCalls: [{ input: { message: "Please wait for cancellation." }, name: "sleeper" }],
    };
  }
  const taskId = /Started task (\S+)\./u.exec(String(started.output))?.[1];
  if (taskId === undefined) throw new Error("The sleeper call returned no task receipt.");
  if (calls("eve__task_wait").length === 0) {
    return { toolCalls: [{ input: { timeoutSeconds: 2 }, name: "eve__task_wait" }] };
  }
  if (calls("eve__task_cancel").length === 0) {
    return { toolCalls: [{ input: { taskId }, name: "eve__task_cancel" }] };
  }
  if (restarted === undefined) {
    return { toolCalls: [{ input: { message: SLEEPER_FOLLOW_UP }, name: "sleeper" }] };
  }
  const result = [...request.messages]
    .reverse()
    .find((entry) => entry.role === "user" && entry.text.startsWith("<task_result"));
  return result?.text ?? { toolCalls: [{ input: {}, name: "eve__task_wait" }] };
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  // `eve__execute` programs ask the sleeper agent as `tools.sleeper({ message })` in the turn.
  codeMode: true,
});
