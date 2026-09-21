/**
 * Stable persisted key. Keep the original wire format when evolving the registry
 * so existing sessions retain their identities, leases, and delivery coordinates.
 * Separate from validation for schema-free workflow readers.
 */
export const AGENT_REGISTRY_STATE_KEY = "eve.agent.handles";
