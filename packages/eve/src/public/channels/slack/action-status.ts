import { displayName } from "#protocol/session-projection/display-name.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";

export function withMoreCalls(label: string, count: number): string {
  return count <= 1 ? label : `${label} +${String(count - 1)} more`;
}

export function waitingOnTasks(names: readonly string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== AGENT_TOOL_NAME) return `Waiting on ${displayName(only!)}...`;
  return names.length === 1
    ? "Waiting on a task..."
    : `Waiting on ${String(names.length)} tasks...`;
}

export function reviewingResults(names: readonly (string | null)[]): string {
  const [first] = names;
  const named = first != null && first !== AGENT_TOOL_NAME && names.every((name) => name === first);
  return named ? `Reviewing ${displayName(first)}'s results...` : "Reviewing results...";
}
