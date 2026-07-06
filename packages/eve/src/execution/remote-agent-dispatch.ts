import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { formatSubagentInput } from "#execution/subagent-invocation.js";
import type { HarnessSession } from "#harness/types.js";
import type { OutboundAuthContext } from "#public/agents/auth.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

export async function startRemoteAgentSession(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly callbackBaseUrl: string | undefined;
  readonly callbackToken?: string;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly session: HarnessSession;
}): Promise<string> {
  const callbackToken = input.callbackToken ?? input.session.continuationToken;
  if (!callbackToken) {
    throw new Error("Cannot dispatch remote agent without a parent continuation token.");
  }
  if (!input.callbackBaseUrl) {
    throw new Error("Cannot dispatch remote agent without a callback base URL.");
  }

  const headers = await resolveRemoteAgentRequestHeaders({
    action: input.action,
    remote: input.remote,
  });
  const response = await fetch(createRemoteAgentSessionUrl(input.remote), {
    body: JSON.stringify({
      callback: {
        callId: input.action.callId,
        subagentName: input.action.remoteAgentName,
        token: callbackToken,
        url: createWorkflowCallbackUrl(
          input.callbackBaseUrl,
          createEveCallbackRoutePath(callbackToken),
        ),
      },
      message: formatRemoteAgentCallInputMessage({ action: input.action, remote: input.remote }),
      mode: "task",
      outputSchema:
        (input.action.input.outputSchema as object | undefined) ?? input.remote.outputSchema,
    }),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session request failed with HTTP ${response.status}.`,
    );
  }

  const sessionIdFromHeader = response.headers.get(EVE_SESSION_ID_HEADER);
  if (sessionIdFromHeader !== null && sessionIdFromHeader.length > 0) {
    return sessionIdFromHeader;
  }

  try {
    const body = (await response.json()) as { readonly sessionId?: unknown };
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      return body.sessionId;
    }
  } catch {
    // Fall through to the generic error below.
  }

  throw new Error(
    `Remote agent "${input.action.remoteAgentName}" create-session response did not include a session id.`,
  );
}

export function resolveRemoteAgentForAction(input: {
  readonly nodeId: string;
  readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
  readonly remoteAgentName: string;
}): ResolvedRuntimeRemoteAgentNode {
  const registered = input.registry.get(input.nodeId);
  const definition = registered?.definition;
  if (definition?.kind !== "remote") {
    throw new Error(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
  }
  return definition;
}

function createRemoteAgentSessionUrl(remote: ResolvedRuntimeRemoteAgentNode): string {
  return new URL(remote.path, `${trimTrailingSlash(remote.url)}/`).toString();
}

async function resolveRemoteAgentRequestHeaders(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (input.remote.headers !== undefined) {
    Object.assign(
      headers,
      typeof input.remote.headers === "function"
        ? await input.remote.headers()
        : input.remote.headers,
    );
  }
  if (input.remote.auth !== undefined) {
    const context: OutboundAuthContext = {
      callId: input.action.callId,
      message: rawRemoteAgentCallMessage(input.action),
      remoteAgentName: input.action.remoteAgentName,
    };
    Object.assign(headers, (await input.remote.auth(context)).headers);
  }
  return headers;
}

function formatRemoteAgentCallInputMessage(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): string {
  return formatSubagentInput({
    description: input.remote.description,
    message: rawRemoteAgentCallMessage(input.action),
    name: input.action.remoteAgentName,
    type: "remote",
  }).message;
}

function rawRemoteAgentCallMessage(action: RuntimeRemoteAgentCallActionRequest): string {
  return typeof action.input.message === "string" ? action.input.message : "";
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
