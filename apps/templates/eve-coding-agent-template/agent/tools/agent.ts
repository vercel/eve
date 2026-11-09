import { disableTool } from "eve/tools";

// Delegate read-only slices to `code__worker` instead of copying the root agent.
export default disableTool();
