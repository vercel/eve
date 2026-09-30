/**
 * Version of the protocol a parent deployment speaks with a remote agent's
 * deployment. A create-session request that delegates work names the caller's
 * version, and the receiver's response names its own. Deployments from before
 * the version existed speak 1.
 */
export const REMOTE_AGENT_PROTOCOL_VERSION = 2;

/**
 * Protocol of eve 0.66–0.68 callers. Receivers still serve these callers, so a
 * receiver can deploy before its callers; support is deprecated.
 */
export const LEGACY_REMOTE_AGENT_PROTOCOL_VERSION = 1;

/** Error code a receiver answers when the caller speaks another protocol version. */
export const REMOTE_AGENT_PROTOCOL_MISMATCH = "REMOTE_AGENT_PROTOCOL_MISMATCH";

/** Reads a peer's protocol version, treating an absent one as the unversioned protocol. */
export function readRemoteAgentProtocolVersion(value: unknown): number {
  return typeof value === "number" ? value : LEGACY_REMOTE_AGENT_PROTOCOL_VERSION;
}

/** The caller's message when a remote agent's deployment speaks another version. */
export function formatRemoteAgentProtocolMismatch(input: {
  readonly name: string;
  readonly receiverVersion: number;
}): string {
  return `Remote agent "${input.name}" speaks eve remote agent protocol ${String(input.receiverVersion)}, but this deployment speaks protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION)}. Upgrade both deployments to the same eve release.`;
}
