import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { webFetch } from "eve/tools/defaults";

export default defineTool({
  ...webFetch,
  needsApproval: always(),
});
