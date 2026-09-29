import { latestTaskResult } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export const REMOTE_QUESTION_DIRECTIVE = "REMOTE-WORKFLOW-QUESTION-7K2M";

export function respondToRemoteQuestion(request: MockModelRequest): MockModelResponse | string {
  if (
    request.userMessages.some((message) => message.includes(`CHILD-${REMOTE_QUESTION_DIRECTIVE}`))
  ) {
    const result = request.toolResults.find((entry) => entry.name === "remote_question");
    if (result === undefined) return { toolCalls: [{ name: "remote_question", input: {} }] };
    if (!String(result.output).includes("REMOTE-QUESTION-ANSWER=alice-ok")) {
      throw new Error("Remote workflow question did not receive Alice's answer.");
    }
    return "REMOTE-QUESTION-COMPLETE";
  }
  const answer = latestTaskResult(request, "remote-loopback");
  if (answer !== undefined) return `PARENT-QUESTION-COMPLETE: ${answer}`;
  if (request.toolResults.some((entry) => entry.name === "remote-loopback")) {
    return { toolCalls: [{ name: "task_wait", input: {} }] };
  }
  return {
    toolCalls: [
      { name: "remote-loopback", input: { message: `CHILD-${REMOTE_QUESTION_DIRECTIVE}` } },
    ],
  };
}
