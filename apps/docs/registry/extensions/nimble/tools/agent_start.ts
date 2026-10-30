import { agent_start } from "@nimble-way/eve/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({
  ...agent_start,
  approval: always(),
});
