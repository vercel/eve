import {
  CALL_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "#protocol/catalog-tools.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { TargetTools } from "#evals/target.js";

/**
 * Names in the reserved `eve` namespace that no call is reported under, so an
 * assertion on one always throws: no agent can declare a tool by that name.
 */
const UNREPORTED_TOOL_NAMES = new Map([
  [
    CALL_TOOL_NAME,
    `Calls through ${CALL_TOOL_NAME} are reported under the entry's name; assert on the tool or agent it reaches.`,
  ],
  [
    SKILL_TOOL_NAME,
    `Calls through ${SKILL_TOOL_NAME} are reported as skill loads; use t.calledSkill(name).`,
  ],
]);

/** Framework tool names eve no longer uses, with what to assert instead. */
const RETIRED_TOOL_NAMES = new Map([
  ["connection_execute", "assert on the connection tool's own name, `<connection>__<tool>`"],
  ["connection_search", `use ${SEARCH_TOOL_NAME}`],
  ["final_output", `use ${REPLY_TOOL_NAME}`],
  ["load_skill", "use t.calledSkill(name)"],
  ["task_cancel", `use ${TASK_CANCEL_TOOL_NAME}`],
  ["task_wait", `use ${TASK_WAIT_TOOL_NAME}`],
]);

/**
 * Throws for a tool name no call is reported under, so an assertion on it can't
 * pass or fail without saying why. `eve__execute` is reported only for an agent
 * with code mode on, and the calls its program makes under their own names. A
 * retired name outside the `eve` namespace is still an ordinary tool name, so it
 * passes when the root agent declares a tool by that name, has a dynamic tool
 * resolver that might return one, or its tools are unknown.
 */
export function assertReportedToolName(name: string, tools: TargetTools | undefined): void {
  const unreported = UNREPORTED_TOOL_NAMES.get(name);
  if (unreported !== undefined) throw new TypeError(unreported);
  if (name === EXECUTE_TOOL_NAME && tools !== undefined && tools.codeMode !== true) {
    throw new TypeError(
      `The agent doesn't have code mode on, so no call is reported under ${EXECUTE_TOOL_NAME}. Set codeMode: true in agent.ts to add ${EXECUTE_TOOL_NAME}.`,
    );
  }
  const replacement = RETIRED_TOOL_NAMES.get(name);
  if (replacement === undefined || tools === undefined) return;
  if (tools.dynamic || tools.static.includes(name)) return;
  throw new TypeError(`Tool name "${name}" was retired; ${replacement}.`);
}
