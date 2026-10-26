/**
 * Version of the protocol a parent deployment speaks with a remote agent's
 * deployment. A create-session request that delegates work names the caller's
 * version, and the receiver's response names its own. Deployments from before
 * the version existed speak 1.
 */
export const REMOTE_AGENT_PROTOCOL_VERSION = 3;

/**
 * Error code a parent's callback route answers when nothing waits on the callback's token: the
 * parent already took the result, or stopped waiting. Its message is the same in every protocol.
 */
export const REMOTE_CALLBACK_NOT_PENDING = "CALLBACK_NOT_PENDING";
export const REMOTE_CALLBACK_NOT_PENDING_MESSAGE = "Session callback not pending.";

/** Error code a receiver answers when the caller speaks another protocol version. */
export const REMOTE_AGENT_PROTOCOL_MISMATCH = "REMOTE_AGENT_PROTOCOL_MISMATCH";

/** Protocol of eve 0.66–0.68, which sent no version. */
export const UNVERSIONED_REMOTE_AGENT_PROTOCOL = 1;

/**
 * Protocol of eve before v27 sessions. Its children relay people's input as v26 requests and take
 * answers as v26 `inputResponses`, which this deployment translates both ways.
 */
export const V26_INPUT_REMOTE_AGENT_PROTOCOL = 2;

/**
 * Query parameter of every callback URL a parent gives a remote child: the protocol they agreed.
 * The callback route reads a child's callbacks by the protocol its URL names, so it never has to
 * guess from a body's shape. A URL without it came from a parent run from before v27.
 */
const CALLBACK_PROTOCOL_QUERY = "eveRemoteProtocol";

/** The callback URL for a child that speaks `version`. */
export function callbackUrlForProtocol(url: string, version: number): string {
  const marked = new URL(url);
  marked.searchParams.set(CALLBACK_PROTOCOL_QUERY, String(version));
  return marked.toString();
}

/** The protocol a callback URL says its parent agreed with the child, if it names one. */
export function readCallbackProtocol(url: string): number | undefined {
  const value = URL.parse(url)?.searchParams.get(CALLBACK_PROTOCOL_QUERY);
  if (value === null || value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

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
