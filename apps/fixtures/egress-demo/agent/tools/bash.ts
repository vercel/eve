import { defineTool, defineBashTool } from "eve/tools";
import { never } from "eve/tools/approval";

/**
 * `approval: never()` keeps the demo about egress authorization: the only
 * human-in-the-loop moment should be the network consent, not a generic
 * command approval.
 */
export default defineTool({
  ...defineBashTool(),
  approval: never(),
});
