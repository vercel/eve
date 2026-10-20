/**
 * Version of the protocol a parent deployment speaks with a remote agent's
 * deployment. A create-session request that delegates work names the caller's
 * version, and the receiver's response names its own. Deployments from before
 * the version existed speak 1.
 */
export const REMOTE_AGENT_PROTOCOL_VERSION = 3;

/** Error code a receiver answers when the caller speaks another protocol version. */
export const REMOTE_AGENT_PROTOCOL_MISMATCH = "REMOTE_AGENT_PROTOCOL_MISMATCH";

/** Protocol of eve 0.66–0.68, which sent no version. */
export const UNVERSIONED_REMOTE_AGENT_PROTOCOL = 1;

/**
 * Whether a remote agent serves a caller on this protocol version. It serves every version back
 * to the unversioned one, but relays requests and streams only to a caller on its own version.
 */
export function servesRemoteAgentCaller(version: number): boolean {
  return (
    Number.isSafeInteger(version) &&
    version >= UNVERSIONED_REMOTE_AGENT_PROTOCOL &&
    version <= REMOTE_AGENT_PROTOCOL_VERSION
  );
}

/** Why a session can't ask its caller for input: the caller speaks an earlier protocol. */
export function formatEarlierRemoteCallerInputError(callerVersion: number): string {
  return `This session needs a person's answer, but its caller's deployment speaks eve remote agent protocol ${String(callerVersion)}, which can't receive approvals, questions, or sign-ins from protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION)}. Upgrade the caller's deployment to the same eve release.`;
}

/** Why a parent can't proxy a remote child's stream: the child speaks an earlier protocol. */
export function formatEarlierRemoteChildStreamError(input: {
  readonly name: string;
  readonly childVersion: number;
}): string {
  return `Remote agent "${input.name}" speaks eve remote agent protocol ${String(input.childVersion)}, so this deployment can't follow its stream. Its result still arrives. Upgrade both deployments to the same eve release to follow it.`;
}

/** Reads a peer's protocol version, treating an absent one as the unversioned protocol. */
export function readRemoteAgentProtocolVersion(value: unknown): number {
  return typeof value === "number" ? value : UNVERSIONED_REMOTE_AGENT_PROTOCOL;
}

/** The caller's message when a remote agent's deployment speaks another version. */
export function formatRemoteAgentProtocolMismatch(input: {
  readonly name: string;
  readonly receiverVersion: number;
}): string {
  return `Remote agent "${input.name}" speaks eve remote agent protocol ${String(input.receiverVersion)}, but this deployment speaks protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION)}. Upgrade both deployments to the same eve release.`;
}
