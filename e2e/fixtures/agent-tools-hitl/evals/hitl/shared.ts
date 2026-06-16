import type { HandleMessageStreamEvent } from "eve/client";

export const GUARDED_ECHO_TOKEN = "guarded-echo-ok-T4Q9";

/**
 * Approval results resolve in the turn AFTER the request was raised, so
 * per-turn `toolCalls` cannot pair them; scan the whole session stream for
 * executed `guarded-echo` action results instead. A denied call executes
 * nothing: it surfaces as a `rejected` `action.result` (skipped here) while
 * the execution-denied output returns to the model as message context.
 */
export function guardedEchoResults(events: readonly HandleMessageStreamEvent[]): string[] {
  const results: string[] = [];
  for (const event of events) {
    if (event.type !== "action.result") continue;
    if (event.data.status === "rejected") continue;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== "guarded-echo") continue;
    results.push(JSON.stringify(result.output ?? ""));
  }
  return results;
}
