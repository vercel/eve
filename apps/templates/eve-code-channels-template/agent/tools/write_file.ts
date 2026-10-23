import { disableTool } from "eve/tools";

// Edits go through `code__apply_patch`, which writes small reviewable hunks.
export default disableTool();
