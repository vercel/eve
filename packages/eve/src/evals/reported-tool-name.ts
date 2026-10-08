import { EXECUTE_TOOL_NAME, SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

/** Framework tool names eve no longer uses, with what to assert instead. */
const RETIRED_TOOL_NAMES = new Map([
  ["connection_execute", "assert on the connection tool's own name, `<connection>__<tool>`"],
  ["connection_search", `use ${SEARCH_TOOL_NAME}`],
  ["final_output", `use ${REPLY_TOOL_NAME}`],
  ["load_skill", "use t.loadedSkill(name)"],
  ["task_cancel", `use ${TASK_CANCEL_TOOL_NAME}`],
  ["task_wait", `use ${TASK_WAIT_TOOL_NAME}`],
]);

/**
 * Throws for a tool name no call is ever reported under, so an assertion on it
 * can't pass or fail without saying why.
 */
export function assertReportedToolName(name: string): void {
  if (name === EXECUTE_TOOL_NAME) {
    throw new TypeError(
      `Calls through ${EXECUTE_TOOL_NAME} are reported under the entry's name; assert on that name, or use t.loadedSkill for skills.`,
    );
  }
  const replacement = RETIRED_TOOL_NAMES.get(name);
  if (replacement !== undefined) {
    throw new TypeError(`Tool name "${name}" was retired; ${replacement}.`);
  }
}
