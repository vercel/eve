/**
 * The authoring surface for workflow tool bodies: `ask`, a small helper over
 * the Workflow SDK that puts a question to the human on the session's channel.
 * The SDK's own constructs — `createHook`, `createWebhook`, `sleep`,
 * `FatalError` — are imported from `workflow` directly.
 */
export { ask } from "#execution/tool-run/messages.js";
