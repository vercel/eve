/**
 * The authoring surface for workflow tool bodies. `ask` is a thin helper over
 * the Workflow SDK; the message types describe what a run resumes on its
 * owner's three hooks (`ctx.owner`). The SDK's own constructs — `createHook`,
 * `createWebhook`, `sleep`, `start`, `resumeHook`, `Run` — are imported from
 * `workflow` and `workflow/api` directly.
 */
export { ask } from "#execution/tool-run/messages.js";
export type {
  RunOutcome,
  RunOutcomeMessage,
  RunRef,
  RunReport,
  RunRequest,
  RunRequestMessage,
} from "#execution/tool-run/messages.js";
