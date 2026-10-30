import { notebookReviewTool } from "../lib/notebook.js";

// The remote notebook keeper is this deployment's root agent (see
// `agent/subagents/remote-loopback.ts`), so the root carries the keeper's tool.
export default notebookReviewTool();
