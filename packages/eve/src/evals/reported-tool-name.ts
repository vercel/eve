import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { TargetTools } from "#evals/target.js";

const UNREPORTED_TOOL_NAMES = new Map([
  [
    CALL_TOOL_NAME,
    `Calls through ${CALL_TOOL_NAME} are reported under the entry's name; assert on the tool or agent it reaches.`,
  ],
  [
    SKILL_TOOL_NAME,
    `Calls through ${SKILL_TOOL_NAME} are reported as skill loads; use t.calledSkill(name).`,
  ],
  [
    "eve__execute",
    "eve__execute isn't a tool eve registers (it's reserved for code mode); assert on the tool or agent a call reaches, or use t.calledSkill(name).",
  ],
]);

const RETIRED_TOOL_NAMES = new Map([
  ["connection_execute", "assert on the connection tool's own name, `<connection>__<tool>`"],
  ["connection_search", `use ${SEARCH_TOOL_NAME}`],
  ["final_output", `use ${REPLY_TOOL_NAME}`],
  ["load_skill", "use t.calledSkill(name)"],
  ["task_cancel", `use ${TASK_CANCEL_TOOL_NAME}`],
  ["task_wait", `use ${TASK_WAIT_TOOL_NAME}`],
]);

export function assertReportedToolName(name: string, tools: TargetTools | undefined): void {
  const unreported = UNREPORTED_TOOL_NAMES.get(name);
  if (unreported !== undefined) throw new TypeError(unreported);
  const replacement = RETIRED_TOOL_NAMES.get(name);
  if (replacement === undefined || tools === undefined) return;
  if (tools.dynamic || tools.static.includes(name)) return;
  throw new TypeError(`Tool name "${name}" was retired; ${replacement}.`);
}
