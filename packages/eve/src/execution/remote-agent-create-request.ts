import {
  UNTRUSTED_AGENT_INVOCATION,
  type ForwardedPrincipal,
} from "#channel/forwarded-principal.js";
import type { SessionParent } from "#channel/types.js";
import {
  createSessionAcceptedResponseSchema,
  traceCoordinatesEqual,
  type AgentInvocationTrace,
} from "#protocol/agent-invocation-trace.js";

export interface RemoteAgentCreateRequestBody {
  readonly forwardedPrincipal?: ForwardedPrincipal;
  readonly invocation?: SessionParent;
  readonly trace?: AgentInvocationTrace;
  readonly [key: string]: unknown;
}

export async function sendRemoteAgentCreateRequest(input: {
  readonly body: RemoteAgentCreateRequestBody;
  readonly headers: Record<string, string>;
  readonly remoteAgentName: string;
  readonly url: string;
}): Promise<{ readonly sessionId: string; readonly traceId?: string }> {
  const send = (body: RemoteAgentCreateRequestBody) =>
    fetch(input.url, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...input.headers },
      method: "POST",
    });
  const sentExtension = input.body.invocation !== undefined || input.body.trace !== undefined;
  let proposedSeed = input.body.trace?.seed;
  let response = await send(input.body);
  const preservesInitiatorSemantics =
    input.body.forwardedPrincipal === undefined ||
    (input.body.forwardedPrincipal.initiator !== undefined &&
      input.body.forwardedPrincipal.initiator !== null);
  const retriesWithoutExtension =
    response.status === 400 ||
    (response.status === 403 &&
      (await readRemoteAgentErrorCode(response.clone())) === UNTRUSTED_AGENT_INVOCATION);
  if (retriesWithoutExtension && sentExtension && preservesInitiatorSemantics) {
    const legacyBody = { ...input.body };
    delete legacyBody.invocation;
    delete legacyBody.trace;
    proposedSeed = undefined;
    response = await send(legacyBody);
  }

  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.remoteAgentName}" create-session request failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Remote agent "${input.remoteAgentName}" create-session response was not valid JSON.`,
    );
  }
  const parsed = createSessionAcceptedResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Remote agent "${input.remoteAgentName}" create-session response was invalid.`);
  }

  const acceptedTraceId =
    proposedSeed !== undefined &&
    parsed.data.trace !== undefined &&
    traceCoordinatesEqual(proposedSeed, parsed.data.trace)
      ? proposedSeed.traceId
      : undefined;
  return acceptedTraceId === undefined
    ? { sessionId: parsed.data.sessionId }
    : { sessionId: parsed.data.sessionId, traceId: acceptedTraceId };
}

async function readRemoteAgentErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object") return undefined;
  const code = Reflect.get(body, "code");
  return typeof code === "string" ? code : undefined;
}
