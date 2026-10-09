import { latestTaskResult, outputOf, playScript } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import {
  SURVEY_DIRECTIVE,
  SURVEY_TOOL_DIRECTIVE,
  SURVEY_WORKER_INPUT_TOKENS,
} from "../../constants.js";

// The survey scripts: the parent starts one survey-worker task and waits for
// it, or calls a workflow tool that opens a `ctx.agent` session with
// survey-worker. The worker's one model call reports more input tokens than
// the parent's whole session budget, so once the worker's usage counts against
// the parent, the parent's next model call stops at its own session-limit
// prompt.

/** Whether a message is Alice's survey request. */
export function isSurveyDirective(message: string): boolean {
  return message.startsWith(`${SURVEY_DIRECTIVE} `);
}

/** Whether a message is Alice's survey request for the workflow tool. */
export function isSurveyToolDirective(message: string): boolean {
  return message.startsWith(`${SURVEY_TOOL_DIRECTIVE} `);
}

/** The parent: starts the survey, waits for it, and reports the worker's answer. */
export function respondAsSurveyParent(request: MockModelRequest): MockModelResponse | string {
  return playScript(
    request,
    [
      {
        id: "survey-start",
        input: () => ({ message: "Please count the tide survey stations for Alice." }),
        name: "survey-worker",
      },
      { id: "survey-wait", name: "eve__task_wait" },
    ],
    (finished) => `SURVEY-REPLY ${latestTaskResult(finished, "survey-worker") ?? "no result"}`,
  );
}

/** The parent: runs the survey through the workflow tool and reports the worker's answer. */
export function respondAsSurveyToolParent(request: MockModelRequest): MockModelResponse | string {
  return playScript(request, [{ id: "survey-tool", name: "survey-through-tool" }], (finished) => {
    const { survey } = JSON.parse(outputOf(finished, "survey-tool")) as { survey: string | null };
    return `SURVEY-REPLY ${survey ?? "no result"}`;
  });
}

/** The worker: answers in one model call that reports a large prompt. */
export function respondAsSurveyWorker(): MockModelResponse {
  return {
    text: "Alice's tide survey has 12 stations.",
    usage: { inputTokens: SURVEY_WORKER_INPUT_TOKENS, outputTokens: 20 },
  };
}
