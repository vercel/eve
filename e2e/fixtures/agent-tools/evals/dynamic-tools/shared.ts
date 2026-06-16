import type { EveEvalTurn } from "eve/evals";

/**
 * Shared constants and helpers for the dynamic tool (`defineDynamic`) smoke
 * evals. Each case names the full registered tool name (`<file>__<key>`) in
 * its prompt so the model calls it.
 */
export const DYNAMIC_ECHO_TOKEN = "dynamic-echo-ok-X7R2";
export const ECHO_TOOL = "dynamic-echo__echo_dynamic";

/**
 * Finds the named tool call inside one turn and returns its object output.
 * Per-turn inspection matters here: the derived `toolCalls` checks see span
 * every turn in the case, so cross-turn comparisons must read `turn.toolCalls`.
 */
export function requireToolOutput(turn: EveEvalTurn, toolName: string): Record<string, unknown> {
  const call = turn.toolCalls.find((candidate) => candidate.name === toolName);
  if (call === undefined) {
    const seen = turn.toolCalls.map((candidate) => candidate.name).join(", ");
    throw new Error(`Expected a "${toolName}" call in this turn; saw [${seen}].`);
  }
  if (typeof call.output !== "object" || call.output === null) {
    throw new Error(
      `Expected object output from "${toolName}"; got ${JSON.stringify(call.output)}.`,
    );
  }
  return call.output as Record<string, unknown>;
}
