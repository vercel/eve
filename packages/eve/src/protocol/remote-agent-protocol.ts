export const REMOTE_AGENT_PROTOCOL_VERSION = 3;

export const REMOTE_CALLBACK_NOT_PENDING = "CALLBACK_NOT_PENDING";
export const REMOTE_CALLBACK_NOT_PENDING_MESSAGE = "Session callback not pending.";

export const REMOTE_AGENT_PROTOCOL_MISMATCH = "REMOTE_AGENT_PROTOCOL_MISMATCH";

export const UNVERSIONED_REMOTE_AGENT_PROTOCOL = 1;

export const V26_INPUT_REMOTE_AGENT_PROTOCOL = 2;

const CALLBACK_PROTOCOL_QUERY = "eveRemoteProtocol";

export function callbackUrlForProtocol(url: string, version: number): string {
  const marked = new URL(url);
  marked.searchParams.set(CALLBACK_PROTOCOL_QUERY, String(version));
  return marked.toString();
}

export function readCallbackProtocol(url: string): number | undefined {
  const value = URL.parse(url)?.searchParams.get(CALLBACK_PROTOCOL_QUERY);
  if (value === null || value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

export function servesRemoteAgentCaller(version: number): boolean {
  return (
    Number.isSafeInteger(version) &&
    version >= V26_INPUT_REMOTE_AGENT_PROTOCOL &&
    version <= REMOTE_AGENT_PROTOCOL_VERSION
  );
}

export function formatEarlierRemoteCallerInputError(callerVersion: number): string {
  return `This session needs a person's answer, but its caller's deployment speaks eve remote agent protocol ${String(callerVersion)}, which can't receive approvals, questions, or sign-ins from protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION)}. Upgrade the caller's deployment to the same eve release.`;
}

export function formatEarlierRemoteChildStreamError(input: {
  readonly name: string;
  readonly childVersion: number;
}): string {
  return `Remote agent "${input.name}" speaks eve remote agent protocol ${String(input.childVersion)}, so this deployment can't follow its stream. Its result still arrives. Upgrade both deployments to the same eve release to follow it.`;
}

export function readRemoteAgentProtocolVersion(value: unknown): number {
  return typeof value === "number" ? value : UNVERSIONED_REMOTE_AGENT_PROTOCOL;
}

export function formatRemoteAgentProtocolMismatch(input: {
  readonly name: string;
  readonly receiverVersion: number;
}): string {
  return `Remote agent "${input.name}" speaks eve remote agent protocol ${String(input.receiverVersion)}, but this deployment speaks protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION)}. Upgrade both deployments to the same eve release.`;
}
