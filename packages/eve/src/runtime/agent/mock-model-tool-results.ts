import {
  type BootstrapPrompt,
  getPromptContentText,
  isTasksNoteText,
} from "#runtime/agent/bootstrap-model-utils.js";
import type { AvailableBootstrapTool } from "#runtime/agent/mock-model-fixtures.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { TASK_WAIT_TOOL_NAME } from "#tools/framework/task-wait.js";

// How the deterministic authored-model mock reads tool results. Detached
// calls return receipts, so the mock waits on each with `task_wait` and then
// reads the wait's result as the result of the call that started the task.
// A task that settled while its turn was parked reaches the turn first as a
// `task.result` message, which the mock reads the same way.

export interface BootstrapToolResult {
  readonly isError: boolean;
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface SettledResult {
  readonly isError: boolean;
  readonly output: unknown;
  readonly toolName: string;
}

const RECEIPT_PATTERNS = [/^Started task ([\w-]+)\./u, /^Sent to task ([\w-]+),/u];
const RESULT_BLOCK_PATTERN =
  /<task_result id="([^"]*)" tool="([^"]*)" status="(\w+)"[^>]*>\n([\s\S]*?)\n<\/task_result>/gu;

type ToolResultPart = Extract<
  Exclude<BootstrapPrompt[number]["content"], string>[number],
  { readonly type: "tool-result" }
>;

/**
 * The latest tool result of the current step sequence, or `null` once a user
 * message follows it. A settled `task_wait`, or a receipt whose result
 * arrived in a `task.result` message, reads as the task's own result.
 */
export function getLastAuthoredToolResult(prompt: BootstrapPrompt): BootstrapToolResult | null {
  const { delivered, parts } = readLatestToolResults(prompt);
  for (const part of parts.toReversed()) {
    if (part.toolName === LOAD_SKILL_TOOL_NAME) continue;
    const raw = rawOutput(part);
    const settled =
      part.toolName === TASK_WAIT_TOOL_NAME
        ? [...readResults(raw)].map(([, result]) => result)[0]
        : delivered.get(receiptTaskId(raw) ?? "");
    return {
      isError:
        settled?.isError ??
        (part.output.type === "error-json" ||
          part.output.type === "error-text" ||
          part.output.type === "execution-denied"),
      output:
        settled?.output ??
        (part.output.type === "execution-denied"
          ? { reason: part.output.reason ?? null, type: part.output.type }
          : part.output.value),
      toolCallId: part.toolCallId,
      toolName: settled?.toolName ?? part.toolName,
    };
  }
  return null;
}

/**
 * One `task_wait` call per receipt in the latest tool results whose result
 * has not arrived yet, so the tasks are waited on together in one step, or
 * `undefined` when there is nothing to wait on or no `task_wait` is offered.
 * Each wait's call ID derives from its receipt's, which is unique: a task an
 * idle agent resumes keeps its task ID, so a wait keyed by the task would
 * repeat an earlier call ID.
 */
export function createTaskWaitCalls(
  prompt: BootstrapPrompt,
  tools: readonly AvailableBootstrapTool[],
):
  | readonly { readonly input: unknown; readonly toolCallId: string; readonly toolName: string }[]
  | undefined {
  if (!tools.some((tool) => tool.name === TASK_WAIT_TOOL_NAME)) return undefined;
  const { delivered, parts } = readLatestToolResults(prompt);
  const waits = parts.flatMap((part) => {
    const taskId = receiptTaskId(rawOutput(part));
    return taskId === undefined || delivered.has(taskId) ? [] : [{ part, taskId }];
  });
  if (waits.length === 0) return undefined;
  return waits.map(({ part, taskId }) => ({
    input: { taskId },
    toolCallId: `call_task_wait_${part.toolCallId}`,
    toolName: TASK_WAIT_TOOL_NAME,
  }));
}

/**
 * The tool results of the latest tool message before any later user input,
 * and the results `task.result` messages after it delivered, by task id.
 */
function readLatestToolResults(prompt: BootstrapPrompt): {
  readonly delivered: ReadonlyMap<string, SettledResult>;
  readonly parts: readonly ToolResultPart[];
} {
  const delivered = new Map<string, SettledResult>();
  for (const message of prompt.toReversed()) {
    if (message.role === "user") {
      const text = getPromptContentText(message.content).trim();
      // Framework-injected [Tasks] notes and task results are scaffolding,
      // not a turn boundary. Treating one as a boundary masks the tool
      // result behind it, and the adapter then re-issues the same call.
      if (isTasksNoteText(text)) continue;
      const results = readResults(text);
      if (results.size === 0) return { delivered, parts: [] };
      for (const [taskId, result] of results) delivered.set(taskId, result);
      continue;
    }
    if (message.role !== "tool" && message.role !== "assistant") continue;
    const parts = message.content.filter(
      (part): part is ToolResultPart => typeof part !== "string" && part.type === "tool-result",
    );
    if (parts.some((part) => part.toolName !== LOAD_SKILL_TOOL_NAME)) return { delivered, parts };
  }
  return { delivered, parts: [] };
}

function rawOutput(part: ToolResultPart): unknown {
  return part.output.type === "execution-denied" ? undefined : part.output.value;
}

function receiptTaskId(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  return RECEIPT_PATTERNS.map((pattern) => pattern.exec(output)?.[1]).find(Boolean);
}

/** The `<task_result>` blocks in a text, by task id. */
function readResults(text: unknown): Map<string, SettledResult> {
  const results = new Map<string, SettledResult>();
  if (typeof text !== "string") return results;
  for (const [, taskId, toolName, status, escaped] of text.matchAll(RESULT_BLOCK_PATTERN)) {
    const body = escaped!.replaceAll("&lt;/task_result", "</task_result");
    let output: unknown = body;
    try {
      output = JSON.parse(body);
    } catch {
      // A text body stays text.
    }
    results.set(taskId!, { isError: status !== "completed", output, toolName: toolName! });
  }
  return results;
}
