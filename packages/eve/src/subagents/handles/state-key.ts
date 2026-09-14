/**
 * Session-state key for delegated agent handles.
 *
 * Lives apart from the store so schema-free readers (the workflow driver's
 * handle query) can import the key without pulling the zod-backed store
 * module into their bundle.
 */
export const AGENT_HANDLES_STATE_KEY = "eve.agent.handles";
