import type { JsonObject, JsonValue } from "#shared/json.js";

/** How a program ended: the value it returned, or why it failed, with what it logged. */
export type ProgramOutcome =
  | { readonly result: JsonValue; readonly logs?: readonly string[] }
  | { readonly error: string; readonly logs?: readonly string[] };

/**
 * The one value the model reads of a program, the same whether `eve__execute` ran it in the turn
 * or a `workflow()` tool ran it in the background: what it returned or why it failed, what it
 * logged, and how many of its calls ended each way.
 */
export function programResult(
  outcome: ProgramOutcome,
  calls: Readonly<Record<string, number>>,
): JsonObject {
  const ended: JsonObject =
    "error" in outcome ? { error: outcome.error } : { result: outcome.result };
  return {
    ...ended,
    ...((outcome.logs?.length ?? 0) > 0 && { logs: [...outcome.logs!] }),
    calls: { ...calls },
  };
}

/** A program's failure, saying that the calls it finished first still happened. */
export function programFailure(error: string, calls: Readonly<Record<string, number>>): string {
  return (calls.completed ?? 0) > 0
    ? `${error} Calls that completed before this are not undone.`
    : error;
}
