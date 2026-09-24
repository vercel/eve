import type { MockModelRequest, MockModelResponder, MockModelToolResult } from "eve/evals";

// Agent calls and most workflow tool calls start a detached task and return a
// receipt. Scripted responders written against a call's result wrap
// themselves in `waitForTasks`, which waits on each receipt with task_wait
// and shows the responder the settled result under the call that started it.

const RECEIPT_PATTERNS = [/^Started task ([\w-]+)\./u, /^Sent your message to agent ([\w-]+),/u];
const RESULT_BLOCK_PATTERN =
  /<task_result id="([^"]*)" name="[^"]*" status="(\w+)"[^>]*>\n([\s\S]*?)\n<\/task_result>/gu;
const WAIT_CALL_PREFIX = "wait-";

interface SettledResult {
  readonly isError: boolean;
  readonly output: unknown;
}

/**
 * Wraps a scripted responder so detached calls read like waited ones. When a
 * step returned receipts, the wrapper calls task_wait once for each task in
 * the next step. The responder then sees each settled result as the output
 * of the call that returned the receipt, and never sees the wait. A result
 * that reached the turn in a `task.result` message first, because the task
 * settled while the turn was parked, is shown the same way, and that message
 * is hidden. A wait that ended without a result (timed out or interrupted)
 * is left in `toolResults` for the responder to handle.
 */
export function waitForTasks(respond: MockModelResponder): MockModelResponder {
  return (request) => {
    const delivered = new Map<string, SettledResult>();
    for (const message of request.messages) {
      if (message.role === "user")
        for (const entry of readResults(message.text)) delivered.set(...entry);
    }
    const waited = new Map<string, SettledResult>();
    for (const result of request.toolResults) {
      if (!result.id.startsWith(WAIT_CALL_PREFIX) || typeof result.output !== "string") continue;
      for (const entry of readResults(result.output)) waited.set(...entry);
    }
    const settled = (taskId: string) => waited.get(taskId) ?? delivered.get(taskId);

    const receipts = request.toolResults.flatMap((result) => {
      const taskId = receiptTaskId(result);
      return taskId === undefined ? [] : [taskId];
    });
    const called = new Set(request.toolResults.map((result) => result.id));
    const pending = receipts.filter(
      (taskId) => settled(taskId) === undefined && !called.has(`${WAIT_CALL_PREFIX}${taskId}`),
    );
    if (pending.length > 0 && request.tools.some((tool) => tool.name === "task_wait")) {
      return {
        toolCalls: pending.map((taskId) => ({
          id: `${WAIT_CALL_PREFIX}${taskId}`,
          input: { taskId },
          name: "task_wait",
        })),
      };
    }

    const shown = new Set(receipts.filter((taskId) => settled(taskId) !== undefined));
    const toolResults = request.toolResults.flatMap((result): MockModelToolResult[] => {
      if (result.id.startsWith(WAIT_CALL_PREFIX)) {
        return waited.has(result.id.slice(WAIT_CALL_PREFIX.length)) ? [] : [result];
      }
      const taskId = receiptTaskId(result);
      const outcome = taskId === undefined ? undefined : settled(taskId);
      return [outcome === undefined ? result : { ...result, ...outcome }];
    });
    const hidden = (text: string) => {
      const ids = [...readResults(text)].map(([taskId]) => taskId);
      return ids.length > 0 && ids.every((taskId) => shown.has(taskId));
    };
    const messages = request.messages.filter(
      (message) => message.role !== "user" || !hidden(message.text),
    );
    const userMessages = request.userMessages.filter((text) => !hidden(text));
    return respond({
      ...request,
      lastUserMessage: userMessages.at(-1) ?? null,
      messages,
      toolResults,
      userMessageCount: userMessages.length,
      userMessages,
    } satisfies MockModelRequest);
  };
}

function receiptTaskId(result: MockModelToolResult): string | undefined {
  if (typeof result.output !== "string") return undefined;
  const text = result.output;
  return RECEIPT_PATTERNS.map((pattern) => pattern.exec(text)?.[1]).find(Boolean);
}

/** The `<task_result>` blocks in a message or a settled wait, by task id. */
function readResults(text: string): Map<string, SettledResult> {
  const results = new Map<string, SettledResult>();
  for (const [, taskId, status, escaped] of text.matchAll(RESULT_BLOCK_PATTERN)) {
    const body = escaped!.replaceAll("&lt;/task_result", "</task_result");
    let output: unknown = body;
    try {
      output = JSON.parse(body);
    } catch {
      // A text body stays text.
    }
    results.set(taskId!, { isError: status !== "completed", output });
  }
  return results;
}
