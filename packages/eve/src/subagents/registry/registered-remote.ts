import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { DynamicRemoteAgentConfig } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { AgentIdentity } from "#subagents/registry/state.js";

export function registeredRemoteConfig(
  identity: AgentIdentity,
): DynamicRemoteAgentConfig | undefined {
  const registration = identity.registration;
  if (registration?.target.kind !== "remote") return undefined;
  return {
    description: registration.description,
    path: EVE_SESSION_ROUTE_PATH,
    publicUrl: true,
    url: registration.target.url,
  };
}

/** An attached conversation is not owned by the registering session. */
export function isAttachedRemoteSession(identity: AgentIdentity): boolean {
  const target = identity.registration?.target;
  return target?.kind === "remote" && target.sessionId !== undefined;
}
