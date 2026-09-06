import { e2eAgentConfig, e2eModel } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponder } from "eve/evals";

import {
  COMPACTION_CHECKPOINT_TEXT,
  CONTENT_OUTPUT_COMPACTION_MARKER,
  CONTENT_OUTPUT_FILENAME,
  CONTENT_OUTPUT_LEAD_MARKER,
  CONTENT_OUTPUT_PAYLOAD_CANARY,
  CONTENT_OUTPUT_TAIL_MARKER,
  TASK_PRESERVED_MARKER,
  TASK_TAIL_SENTINEL,
} from "../constants";
import { assistantHasReport } from "../report-evidence";
import { handoffReferences, reviewReferences } from "../release-reports";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
// The compiled fixture's instructions and 13 advertised tools occupy ~2,823
// tokens. Keep the original 640-token history pressure after reserving them.
const TEST_REQUEST_ENVELOPE_TOKENS = 2_823;
const TEST_HISTORY_BUDGET_TOKENS = 640;
const MAX_TOOL_CALLS = 10;

type RegressionCase =
  | "content-output-file-stub"
  | "redundant-tool-calls"
  | "stale-todo-work"
  | "task-survival";

let activeCase: RegressionCase | undefined;
const handoffCallCounts = new Map<RegressionCase, number>();
const toolCallCounts = new Map<RegressionCase, number>();

/** One entry per content-output-file-stub model call, rendered by {@link renderHistoryShape}. */
const contentOutputHistoryShapes: string[] = [];

/**
 * Renders one request's message list as a stable role:kind sequence so the
 * eval can assert the exact conversation shape around a compaction. Kinds are
 * derived from framework-owned sentinels, not content the summarizer writes.
 */
function renderHistoryShape(request: MockModelRequest): string {
  return request.messages
    .map((message, index) => {
      if (message.role === "system") return "system";
      if (message.role === "tool") return "tool:result";
      if (message.role === "assistant") {
        const previous = request.messages[index - 1];
        if (previous?.role === "user" && previous.text === COMPACTION_CHECKPOINT_TEXT) {
          return "assistant:checkpoint";
        }
        return message.text.trim().length === 0 ? "assistant:tool-call" : "assistant:text";
      }
      if (message.text === COMPACTION_CHECKPOINT_TEXT) return "user:checkpoint-marker";
      if (message.text.includes("[case: content-output-file-stub]")) return "user:task";
      if (message.text === "Continue.") return "user:resume";
      return `user:other(${message.text.replace(/\s+/g, " ").slice(0, 32)})`;
    })
    .join(" > ");
}

let requestCount = 0;

const taskModel = mockModel({
  modelId: "compaction-regression-task-model",
  respond: withFullRequestUsage((request) => {
    // EVE_E2E_DUMP_CONTEXT=1 prints every request's messages — the context
    // exactly as the model sees it, so compaction, capping, and replay are
    // observable per step while iterating on these evals.
    if (process.env.EVE_E2E_DUMP_CONTEXT) {
      requestCount += 1;
      console.log(`\n=== model request #${requestCount} (${request.messages.length} messages) ===`);
      for (const message of request.messages) {
        const text = message.text.replace(/\s+/g, " ");
        console.log(`  [${message.role}] ${text.length} chars | ${text.slice(0, 160)}`);
      }
    }

    const initialCase = findInitialCase(request);
    if (initialCase !== undefined && activeCase !== initialCase) {
      activeCase = initialCase;
      handoffCallCounts.set(initialCase, 0);
      toolCallCounts.set(initialCase, 0);
    }

    if (activeCase === undefined) {
      throw new Error("Compaction regression task model received no case marker.");
    }

    const regressionCase = activeCase;

    if (regressionCase === "content-output-file-stub") {
      contentOutputHistoryShapes.push(renderHistoryShape(request));
      // Compaction's tool-result cap heuristic rewrites the oversized content
      // output in place: same messages, file part reduced to its text stub.
      // The canary's absence is the detection signal — the raw payload can
      // only be missing from the tool message if the cap ran.
      const toolText = request.messages.find((message) => message.role === "tool")?.text;
      const capped = toolText !== undefined && !toolText.includes(CONTENT_OUTPUT_PAYLOAD_CANARY);
      if (toolText !== undefined && capped) {
        const diagnostics = [
          toolText.includes(CONTENT_OUTPUT_TAIL_MARKER) ? "TAIL_PRESERVED" : "TAIL_LOST",
          toolText.includes(CONTENT_OUTPUT_LEAD_MARKER) ? "LEAD_PRESERVED" : "LEAD_LOST",
          toolText.includes(`Attached file ${CONTENT_OUTPUT_FILENAME}`)
            ? "FILE_STUB_RENDERED"
            : "FILE_STUB_LOST",
          request.userMessages.some((text) => text.includes("[case: content-output-file-stub]"))
            ? "NEIGHBOR_PRESERVED"
            : "NEIGHBOR_LOST",
        ];
        const honored = !diagnostics.some((entry) => entry.endsWith("_LOST"));
        const history = contentOutputHistoryShapes
          .map((shape, index) => `${index + 1}: ${shape}`)
          .join(" ;; ");
        return honored
          ? `Capped history honored the content-output contract (${diagnostics.join(", ")}): ` +
              `${CONTENT_OUTPUT_COMPACTION_MARKER} HISTORY<${history}>`
          : `Capped history violated the content-output contract: ${diagnostics.join(", ")} ` +
              `HISTORY<${history}>`;
      }

      const contentOutputCalls = toolCallCounts.get(regressionCase) ?? 0;
      if (contentOutputCalls >= 1) {
        return "Hard stop without a compaction: CONTENT_OUTPUT_NO_COMPACTION";
      }

      toolCallCounts.set(regressionCase, contentOutputCalls + 1);
      return {
        toolCalls: [
          {
            id: "emit-compaction-content-1",
            input: {},
            name: "emit-compaction-content",
          },
        ],
      };
    }

    if (regressionCase === "task-survival") {
      const compacted = request.messages.some(
        (message) => message.role === "user" && message.text === COMPACTION_CHECKPOINT_TEXT,
      );
      if (compacted) {
        // The harness must hand the model its verbatim task back after
        // compaction — via the kept tail or the resumption replay. Losing it
        // is the trace failure this case pins.
        return request.userMessages.some((text) => text.includes(TASK_TAIL_SENTINEL))
          ? `Task text still visible: ${TASK_PRESERVED_MARKER}`
          : "Task text lost after compaction: TASK_LOST";
      }

      const pressureCalls = toolCallCounts.get(regressionCase) ?? 0;
      if (pressureCalls >= MAX_TOOL_CALLS) {
        return "Hard stop without a compaction: TASK_SURVIVAL_NO_COMPACTION";
      }

      toolCallCounts.set(regressionCase, pressureCalls + 1);
      return {
        toolCalls: [
          {
            id: `inspect-repository-${pressureCalls + 1}`,
            input: { scope: "repository" },
            name: "inspect-repository",
          },
        ],
      };
    }

    const subject = regressionCase === "redundant-tool-calls" ? "repository" : "checkout";
    const reviewId = reviewReferences[subject];
    const handoffId = handoffReferences[subject];

    if (assistantHasReport(request.messages, reviewId)) {
      if (assistantHasReport(request.messages, handoffId)) {
        return `The completed review is recorded as ${reviewId}. The release handoff is ready at ${handoffId}.`;
      }

      const handoffCalls = handoffCallCounts.get(regressionCase) ?? 0;
      if (handoffCalls >= MAX_TOOL_CALLS) {
        return "The review is complete, but the release handoff could not be confirmed.";
      }
      handoffCallCounts.set(regressionCase, handoffCalls + 1);
      return {
        toolCalls: [
          {
            id: `prepare-handoff-${handoffCalls + 1}`,
            input: { subject, reviewId },
            name: "prepare-handoff",
          },
        ],
      };
    }

    const reviewCalls = toolCallCounts.get(regressionCase) ?? 0;
    if (reviewCalls >= MAX_TOOL_CALLS) {
      return "The review could not be confirmed, so a release handoff is not ready.";
    }
    toolCallCounts.set(regressionCase, reviewCalls + 1);
    return {
      toolCalls: [
        {
          id: `${subject}-review-${reviewCalls + 1}`,
          input: { scope: subject },
          name: subject === "repository" ? "inspect-repository" : "perform-source-analysis",
        },
      ],
    };
  }),
});

export default defineAgent({
  // Harness config wires the workflow world; the task model stays the
  // fixture's scripted mock regardless of the matrix model.
  ...e2eAgentConfig(),
  model: taskModel,
  modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
  compaction: {
    model: e2eModel(),
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    thresholdPercent:
      (TEST_REQUEST_ENVELOPE_TOKENS + TEST_HISTORY_BUDGET_TOKENS) / TEST_CONTEXT_WINDOW_TOKENS,
  },
  limits: {
    maxInputTokensPerSession: 100_000,
  },
});

function findInitialCase(request: MockModelRequest): RegressionCase | undefined {
  for (const message of request.userMessages) {
    const regressionCase = regressionCaseFromText(message);
    if (regressionCase !== undefined) return regressionCase;
  }

  return undefined;
}

function regressionCaseFromText(text: string): RegressionCase | undefined {
  if (text.includes("[case: content-output-file-stub]")) return "content-output-file-stub";
  if (text.toLowerCase().includes("review the storefront repository"))
    return "redundant-tool-calls";
  if (text.toLowerCase().includes("review the checkout implementation")) return "stale-todo-work";
  if (text.includes("[case: task-survival]")) return "task-survival";
  return undefined;
}

function withFullRequestUsage(respond: MockModelResponder): MockModelResponder {
  return async (request) => {
    const response = await respond(request);
    const history = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.text }));
    // Real providers include the tool catalog in reported input usage. The
    // mock's default text-only estimate would hide that cost on later steps.
    return {
      ...(typeof response === "string" ? { text: response } : response),
      usage: {
        inputTokens: TEST_REQUEST_ENVELOPE_TOKENS + Math.ceil(JSON.stringify(history).length / 4),
      },
    };
  };
}
