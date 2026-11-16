import { disableTool } from "eve/tools";

// GitHub operations use the runtime extension, not a root shell. Repository
// execution belongs only in the independent, uncredentialed station sandboxes.
export default disableTool();
