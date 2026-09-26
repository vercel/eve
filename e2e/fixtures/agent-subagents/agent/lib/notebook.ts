import {
  latestTaskResult,
  outputOf,
  playScript,
  taskIdFromReceipt,
  type ScriptedCall,
} from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import {
  CORRECTED_MEASUREMENT,
  NOTEBOOK_DIRECTIVES,
  NOTEBOOK_ENTRY,
  NOTEBOOK_NAME,
  type NotebookDirective,
} from "../../constants.js";

// The notebook continuation script. Over three parent turns, the parent asks a
// keeper agent to remember a name, gives the same task a review that it
// cancels, then asks the same task for the name again. Only a keeper whose
// conversation survived the cancel can answer.
//
// The correction script is one parent turn: the parent asks a keeper to
// measure a pier, then corrects the pier by `taskId` while the keeper's
// measurement is still running, and waits for the corrected answer.

const REMEMBER_ENTRY = `${NOTEBOOK_ENTRY} Alice named the tide station notebook ${NOTEBOOK_NAME}. Remember that name.`;
const REVIEW_ENTRY = `${NOTEBOOK_ENTRY} Please review the notebook pages before Alice's next question.`;
const RECALL_ENTRY = `${NOTEBOOK_ENTRY} What name did Alice give the tide station notebook?`;
const MEASURE_ENTRY = `${NOTEBOOK_ENTRY} Please measure the tide depth at the north pier for Alice.`;
const CORRECTION_ENTRY = `${NOTEBOOK_ENTRY} Correction: Alice meant the south pier, not the north pier.`;

/** Whether a message is one of the parent's notebook directives, such as `NOTEBOOK-RECALL notebook-keeper`. */
export function isNotebookDirective(message: string): boolean {
  return NOTEBOOK_DIRECTIVES.some((directive) => message.startsWith(`${directive} `));
}

/** Whether a message is one the parent sent a keeper; eve wraps the first one in a preamble. */
export function isNotebookEntry(message: string): boolean {
  return message.includes(`${NOTEBOOK_ENTRY} `);
}

/** The parent: plays the calls for the latest directive against the keeper tool it names. */
export function respondAsNotebookParent(request: MockModelRequest): MockModelResponse | string {
  const latest = [...request.userMessages].reverse().find(isNotebookDirective);
  if (latest === undefined) throw new Error("The notebook parent received no directive.");
  const [directive, tool] = latest.split(/\s+/u) as [NotebookDirective, string];
  const { calls, finish } = parentTurn(directive, tool);
  return playScript(request, calls, () => `NOTEBOOK-REPLY ${finish(request)}`);
}

function parentTurn(
  directive: NotebookDirective,
  tool: string,
): {
  readonly calls: readonly ScriptedCall[];
  readonly finish: (request: MockModelRequest) => string | undefined;
} {
  const keeperTask = (request: MockModelRequest) => taskIdFromReceipt(request, "notebook-remember");
  switch (directive) {
    case "NOTEBOOK-REMEMBER":
      return {
        calls: [
          { id: "notebook-remember", input: () => ({ message: REMEMBER_ENTRY }), name: tool },
          { id: "notebook-remember-wait", name: "task_wait" },
        ],
        finish: (request) => latestTaskResult(request, tool),
      };
    case "NOTEBOOK-REVIEW":
      return {
        calls: [
          {
            id: "notebook-review",
            input: (request) => ({ message: REVIEW_ENTRY, taskId: keeperTask(request) }),
            name: tool,
          },
          { id: "notebook-review-wait", input: () => ({ timeout: 2_000 }), name: "task_wait" },
          {
            id: "notebook-cancel",
            input: (request) => ({ taskId: keeperTask(request) }),
            name: "task_cancel",
          },
        ],
        finish: (request) => outputOf(request, "notebook-cancel"),
      };
    case "NOTEBOOK-RECALL":
      return {
        calls: [
          {
            id: "notebook-recall",
            input: (request) => ({ message: RECALL_ENTRY, taskId: keeperTask(request) }),
            name: tool,
          },
          { id: "notebook-recall-wait", name: "task_wait" },
        ],
        finish: (request) => latestTaskResult(request, tool),
      };
    case "NOTEBOOK-CORRECT":
      return {
        calls: [
          { id: "notebook-measure", input: () => ({ message: MEASURE_ENTRY }), name: tool },
          {
            id: "notebook-correction",
            input: (request) => ({
              message: CORRECTION_ENTRY,
              taskId: taskIdFromReceipt(request, "notebook-measure"),
            }),
            name: tool,
          },
          { id: "notebook-correction-wait", name: "task_wait" },
        ],
        finish: (request) => latestTaskResult(request, tool),
      };
  }
}

/**
 * A keeper, local or remote: saves the name, reviews until its turn is
 * cancelled, and answers the name from its own conversation.
 */
export function respondAsNotebookKeeper(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes(REMEMBER_ENTRY)) return "NOTEBOOK-SAVED";
  if (message.includes(REVIEW_ENTRY)) {
    const reviewId = `notebook-review-${String(request.userMessageCount)}`;
    return playScript(
      request,
      [{ id: reviewId, name: "notebook-review" }],
      () => "NOTEBOOK-REVIEWED",
    );
  }
  if (message.includes(RECALL_ENTRY)) {
    const remembers = request.userMessages.some((entry) => entry.includes(REMEMBER_ENTRY));
    return `NOTEBOOK-NAME=${remembers ? NOTEBOOK_NAME : "unknown"}`;
  }
  if (message.includes(MEASURE_ENTRY)) {
    const measureId = `notebook-measure-${String(request.userMessageCount)}`;
    return playScript(request, [{ id: measureId, name: "notebook-measure" }], measuredPier);
  }
  if (message.includes(CORRECTION_ENTRY)) return CORRECTED_MEASUREMENT;
  throw new Error(`The notebook keeper received an unexpected message: ${message}`);
}

/** Reports the pier of the latest instruction the keeper has read. */
function measuredPier(request: MockModelRequest): string {
  const corrected = request.userMessages.some((entry) => entry.includes(CORRECTION_ENTRY));
  return corrected ? CORRECTED_MEASUREMENT : "NOTEBOOK-DEPTH north pier 3.1 m";
}

const REVIEW_FALLBACK_MS = 60_000;

/** The keeper's review: works until its turn is cancelled, far longer than the parent waits. */
export function notebookReviewTool() {
  return defineTool({
    description: `Test fixture: reviews notebook pages until the review is cancelled. Only call when a ${NOTEBOOK_ENTRY} message asks for a notebook review.`,
    inputSchema: z.object({}),
    approval: never(),
    execute: (_input, ctx) => reviewUntilCancelled(ctx.abortSignal),
  });
}

function reviewUntilCancelled(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = setTimeout(() => resolve("The review finished."), REVIEW_FALLBACK_MS);
    const cancel = (): void => {
      clearTimeout(finish);
      reject(signal.reason);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Long enough that the parent's correction arrives while the measurement runs. */
const MEASURE_MS = 5_000;

/** The keeper's measurement: finishes on its own after a few seconds. */
export function notebookMeasureTool() {
  return defineTool({
    description: `Test fixture: measures the tide depth at a pier. Only call when a ${NOTEBOOK_ENTRY} message asks for a measurement.`,
    inputSchema: z.object({}),
    approval: never(),
    execute: () => measureAfterDelay(),
  });
}

function measureAfterDelay(): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("The measurement finished."), MEASURE_MS);
  });
}
