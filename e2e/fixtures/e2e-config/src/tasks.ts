import type { MockModelRequest, MockModelResponder, MockModelToolResult } from "eve/evals";

// Agent calls and most workflow tool calls start a detached task and return a
// receipt. Scripted responders written against a call's result wrap
// themselves in `waitForTasks`, which waits on each receipt with task_wait
// and shows the responder the settled result under the call that started it.

const START_RECEIPT_PATTERN = /^Started task ([\w-]+)\./u;
const SEND_RECEIPT_PATTERN =
  /^Sent to task ([\w-]+), which is (still working|now working on it)\./u;
const RESULT_BLOCK_PATTERN =
  /<task_result id="([^"]*)" tool="[^"]*" status="(\w+)"[^>]*>\n([\s\S]*?)\n<\/task_result>/gu;
const WAIT_CALL_PREFIX = "task-wait-for-";

interface SettledResult {
  readonly isError: boolean;
  readonly output: unknown;
}

/**
 * One unit of a task's work: the call that started it and any input sent to
 * it while it worked. A send keeps the task's ID, so each start, and each
 * send to an idle task, opens a new generation, and results pair with them
 * in call order.
 */
interface Generation {
  readonly taskId: string;
  /** Receipt call IDs, the start first. */
  readonly callIds: string[];
  result?: SettledResult;
}

/**
 * Wraps a scripted responder so detached calls read like waited ones. When a
 * step returned receipts, the wrapper calls task_wait once for each task in
 * the next step, keyed by the receipt's call ID. The responder then sees each
 * settled result as the output of the call that returned the receipt, and
 * never sees the wait. A result that reached the turn in a `task.result`
 * message first, because the task settled while the turn was parked, pairs
 * with the task's earliest generation still without a result, and that
 * message is hidden. A wait that ended without a result (timed out,
 * interrupted, or idle) is left in `toolResults` for the responder to handle.
 */
export function waitForTasks(respond: MockModelResponder): MockModelResponder {
  return (request) => {
    const generations = readGenerations(request.toolResults);
    const byCallId = new Map(
      generations.flatMap((generation) => generation.callIds.map((id) => [id, generation])),
    );
    // A wait names the receipt it waits for, so its result needs no pairing.
    const waited = new Set<string>();
    for (const result of request.toolResults) {
      if (!result.id.startsWith(WAIT_CALL_PREFIX) || typeof result.output !== "string") continue;
      const generation = byCallId.get(result.id.slice(WAIT_CALL_PREFIX.length));
      const [settled] = readResults(result.output);
      if (generation === undefined || settled === undefined) continue;
      generation.result = settled.result;
      waited.add(result.id);
    }
    // A delivered result goes to the task's earliest generation still waiting for one.
    const pairedBlocks = new Set<string>();
    for (const [index, message] of request.messages.entries()) {
      if (message.role !== "user") continue;
      for (const [blockIndex, block] of readResults(message.text).entries()) {
        const generation = generations.find(
          (candidate) => candidate.taskId === block.taskId && candidate.result === undefined,
        );
        if (generation === undefined) continue;
        generation.result = block.result;
        pairedBlocks.add(`${index}:${blockIndex}`);
      }
    }

    const called = new Set(request.toolResults.map((result) => result.id));
    const pending = generations.filter(
      (generation) =>
        generation.result === undefined &&
        !generation.callIds.some((callId) => called.has(`${WAIT_CALL_PREFIX}${callId}`)),
    );
    if (pending.length > 0 && request.tools.some((tool) => tool.name === "task_wait")) {
      return {
        toolCalls: pending.map((generation) => ({
          id: `${WAIT_CALL_PREFIX}${generation.callIds.at(-1)!}`,
          input: { taskId: generation.taskId },
          name: "task_wait",
        })),
      };
    }

    const toolResults = request.toolResults.flatMap((result): MockModelToolResult[] => {
      if (waited.has(result.id)) return [];
      const outcome = byCallId.get(result.id)?.result;
      return [outcome === undefined ? result : { ...result, ...outcome }];
    });
    const hidden = new Set<number>();
    for (const [index, message] of request.messages.entries()) {
      if (message.role !== "user") continue;
      const blocks = readResults(message.text);
      if (blocks.length > 0 && blocks.every((_, block) => pairedBlocks.has(`${index}:${block}`))) {
        hidden.add(index);
      }
    }
    const messages = request.messages.filter((_, index) => !hidden.has(index));
    const hiddenTexts = new Set(
      request.messages.filter((_, index) => hidden.has(index)).map((message) => message.text),
    );
    const userMessages = request.userMessages.filter((text) => !hiddenTexts.has(text));
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

/**
 * The task generations the receipts in `toolResults` stand for, in call
 * order. A start, or a send to an idle task, opens a generation; a send to a
 * working task joins that task's latest generation.
 */
function readGenerations(toolResults: readonly MockModelToolResult[]): Generation[] {
  const generations: Generation[] = [];
  for (const result of toolResults) {
    if (typeof result.output !== "string") continue;
    const started = START_RECEIPT_PATTERN.exec(result.output)?.[1];
    if (started !== undefined) {
      generations.push({ callIds: [result.id], taskId: started });
      continue;
    }
    const sent = SEND_RECEIPT_PATTERN.exec(result.output);
    const taskId = sent?.[1];
    if (taskId === undefined) continue;
    const joined =
      sent?.[2] === "still working"
        ? generations.filter((generation) => generation.taskId === taskId).at(-1)
        : undefined;
    if (joined === undefined) generations.push({ callIds: [result.id], taskId });
    else joined.callIds.push(result.id);
  }
  return generations;
}

/** The `<task_result>` blocks in a message or a settled wait, in order. */
function readResults(
  text: string,
): readonly { readonly result: SettledResult; readonly taskId: string }[] {
  return [...text.matchAll(RESULT_BLOCK_PATTERN)].map(([, taskId, status, escaped]) => {
    const body = escaped!.replaceAll("&lt;/task_result", "</task_result");
    let output: unknown = body;
    try {
      output = JSON.parse(body);
    } catch {
      // A text body stays text.
    }
    return { result: { isError: status !== "completed", output }, taskId: taskId! };
  });
}
