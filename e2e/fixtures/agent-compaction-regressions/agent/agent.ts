import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

import {
  COMPACTION_CHECKPOINT_TEXT,
  CONTENT_OUTPUT_COMPACTION_MARKER,
  CONTENT_OUTPUT_FILENAME,
  CONTENT_OUTPUT_LEAD_MARKER,
  CONTENT_OUTPUT_PAYLOAD_CANARY,
  CONTENT_OUTPUT_TAIL_MARKER,
  SECOND_CHECKPOINT_MARKER,
  TASK_PRESERVED_MARKER,
  TASK_TAIL_SENTINEL,
} from "../constants";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_TOOL_CALLS = 10;

type RegressionCase =
  | "content-output-file-stub"
  | "redundant-tool-calls"
  | "stale-todo-work"
  | "task-survival";

let activeCase: RegressionCase | undefined;
const checkpointAdvanceCallCounts = new Map<RegressionCase, number>();
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
  respond(request) {
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
      checkpointAdvanceCallCounts.set(initialCase, 0);
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

    const marker = completionMarker(regressionCase);

    // These are fixture markers, not compaction protocol fields. `marker` records the
    // regression work tool; `SECOND_CHECKPOINT_MARKER` records the test-only tool
    // whose output makes the harness cross the compaction threshold a second time.
    // Completion evidence is detected in any assistant message: compaction may
    // leave it as a summarization checkpoint or as an eviction trail line, and
    // the model must not repeat work in either case. User messages are
    // excluded because the eval instructions themselves quote the markers.
    if (assistantEvidenceContains(request.messages, marker)) {
      if (assistantEvidenceContains(request.messages, SECOND_CHECKPOINT_MARKER)) {
        return `Done: ${marker}; ${SECOND_CHECKPOINT_MARKER}`;
      }

      const advanceCalls = checkpointAdvanceCallCounts.get(regressionCase) ?? 0;
      if (advanceCalls >= MAX_TOOL_CALLS) {
        return `Hard stop after ${MAX_TOOL_CALLS} checkpoint advances: ${marker}`;
      }

      checkpointAdvanceCallCounts.set(regressionCase, advanceCalls + 1);
      return {
        toolCalls: [
          {
            id: `advance-checkpoint-${advanceCalls + 1}`,
            input: { regressionCase },
            name: "advance-checkpoint",
          },
        ],
      };
    }

    const completedCalls = toolCallCounts.get(regressionCase) ?? 0;
    if (completedCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: ${marker}`;
    }

    const attempt = completedCalls + 1;
    toolCallCounts.set(regressionCase, attempt);

    return regressionCase === "redundant-tool-calls"
      ? {
          toolCalls: [
            {
              id: `inspect-repository-${attempt}`,
              input: { scope: "repository" },
              name: "inspect-repository",
            },
          ],
        }
      : {
          toolCalls: [
            {
              id: `perform-source-analysis-${attempt}`,
              input: { approach: `attempt-${attempt}` },
              name: "perform-source-analysis",
            },
          ],
        };
  },
});

export default defineAgent({
  model: taskModel,
  modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
  compaction: {
    model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.02,
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
  if (text.includes("[case: redundant-tool-calls]")) return "redundant-tool-calls";
  if (text.includes("[case: stale-todo-work]")) return "stale-todo-work";
  if (text.includes("[case: task-survival]")) return "task-survival";
  return undefined;
}

function completionMarker(
  regressionCase: Exclude<RegressionCase, "content-output-file-stub" | "task-survival">,
): string {
  return regressionCase === "redundant-tool-calls"
    ? "REPOSITORY_INSPECTION_COMPLETE"
    : "SOURCE_ANALYSIS_COMPLETE";
}

function assistantEvidenceContains(
  messages: MockModelRequest["messages"],
  marker: string,
): boolean {
  return messages.some((message) => message.role === "assistant" && message.text.includes(marker));
}
