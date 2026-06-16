import { defineTool, defineBashTool } from "eve/tools";
import { never } from "eve/tools/approval";

/**
 * Bash tool exposed to the model for the sandbox-bootstrap smoke
 * test. `needsApproval: never()` keeps the smoke test single-turn
 * and avoids tripping the HITL machinery already exercised by
 * `tool-approval.ts` / `tool-denial.ts`.
 *
 * Wrapping the framework's `defineBashTool()` in `defineTool({...})`
 * gives the inferred default a named return type so tsgo does not
 * trip the TS2883 "inferred type cannot be named" portability
 * check.
 */
export default defineTool({
  ...defineBashTool(),
  needsApproval: never(),
});
