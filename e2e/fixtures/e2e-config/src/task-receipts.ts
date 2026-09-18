import type { EveEvalTurn } from "eve/evals";

/** Admission receipts are tool results; subagent completion carries the child's final output. */
export function taskReceipts(events: EveEvalTurn["events"]) {
  return events.flatMap((event) => {
    if (event.type !== "action.result" || event.data.status !== "completed") return [];
    const result = event.data.result;
    if (result.kind !== "tool-result") return [];
    const output = result.output;
    if (
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output) ||
      Reflect.get(output, "status") !== "working"
    )
      return [];
    const taskId: unknown = Reflect.get(output, "taskId");
    if (typeof taskId !== "string") return [];
    return [{ callId: result.callId, taskId, toolName: result.toolName }];
  });
}
