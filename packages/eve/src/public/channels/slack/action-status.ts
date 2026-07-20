/**
 * Typing-indicator labels for requested actions. The Slack indicator is
 * plain text (`assistant.threads.setStatus` renders no markdown), so the
 * label is the action's name plus its most telling argument — `grep useEve`
 * or `read_file agent/agent.ts` instead of `Running grep...`.
 */
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

/** Argument keys worth surfacing, most telling first, per tool. */
const SALIENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
  glob: ["pattern"],
  grep: ["pattern", "path"],
  load_skill: ["skill"],
  read_file: ["filePath"],
  web_fetch: ["url"],
  web_search: ["query"],
  write_file: ["filePath"],
};

/** Fallback keys probed on tools without a {@link SALIENT_KEYS} entry. */
const GENERIC_KEYS: readonly string[] = [
  "filePath",
  "path",
  "pattern",
  "command",
  "query",
  "name",
  "repo",
  "url",
  "issueNumber",
  "number",
];

const MAX_ARG_CHARS = 40;

function salientArg(toolName: string, input: Readonly<Record<string, unknown>>): string | null {
  for (const key of SALIENT_KEYS[toolName] ?? GENERIC_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** Keep the tail of a path: `agent/lib/triage/cards.ts` -> `triage/cards.ts`. */
function shortenArg(text: string): string {
  const oneLine = text.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (oneLine.length <= MAX_ARG_CHARS) return oneLine;
  if (oneLine.includes("/") && !oneLine.includes(" ")) {
    const segments = oneLine.split("/").filter((s) => s.length > 0);
    const tail = segments.slice(-2).join("/");
    if (tail.length <= MAX_ARG_CHARS) return tail;
  }
  return `${oneLine.slice(0, MAX_ARG_CHARS - 3).trimEnd()}...`;
}

function toolCallLabel(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const arg = salientArg(toolName, input);
  return arg === null ? toolName : `${toolName} ${shortenArg(arg)}`;
}

/**
 * One action's typing-indicator label: `grep useEveAgent` for tool calls,
 * the subagent or remote-agent name for dispatched calls, and
 * `load_skill <name>` for skill loads.
 */
export function describeActionRequest(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return toolCallLabel("load_skill", action.input);
    case "remote-agent-call":
      return action.remoteAgentName;
    case "subagent-call":
      return action.subagentName;
    case "tool-call":
      return toolCallLabel(action.toolName, action.input);
  }
}

/**
 * Typing-indicator text for one requested batch: the first action's
 * {@link describeActionRequest} label, plus `+N more` when the model
 * requested several actions at once.
 */
export function describeActionRequests(actions: readonly RuntimeActionRequest[]): string {
  const [first] = actions;
  if (first === undefined) return "Working...";
  const label = describeActionRequest(first);
  return actions.length === 1 ? label : `${label} +${actions.length - 1} more`;
}
