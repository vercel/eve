import type { JsonValue } from "#shared/json.js";
import type { RelayRoute } from "#channel/types.js";
import { isSessionInboxAddress } from "#execution/session-inbox/address.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

/**
 * Marks a request as a workflow tool run's `ctx.ask()` question, rather than a
 * child session's. Its answer goes to the run's control hook, which carries
 * every decision the session makes for the run, in order.
 */
export interface WorkflowAskRoute {
  readonly control: string;
}

/**
 * Where answers to one relayed request go. What the request asks, and how it stands, is its
 * interaction row; this is only the way back to the asker.
 */
export interface Relay extends RelayRoute {
  readonly workflowAsk?: WorkflowAskRoute;
  /**
   * The workflow tool run that relayed the request: its own `ctx.ask()`
   * question, or a request from a session it opened with `ctx.agent`. Nobody
   * can answer the request once that run ends.
   */
  readonly runId?: string;
}

/** Reads one stored route, or `undefined` when it is malformed. */
export function parseRelay(value: unknown): Relay | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const token = Reflect.get(value, "childContinuationToken");
  if (typeof token !== "string") return undefined;
  const relay: {
    -readonly [K in keyof Relay]: Relay[K];
  } = { childContinuationToken: token };
  const inputSource = Reflect.get(value, "inputSource");
  if (inputSource !== undefined) {
    if (typeof inputSource !== "string" || inputSource.length === 0) return undefined;
    relay.inputSource = inputSource;
  }
  const inbox = Reflect.get(value, "childSessionInbox");
  if (inbox !== undefined) {
    if (!isSessionInboxAddress(inbox)) return undefined;
    relay.childSessionInbox = inbox;
  }
  const remote = Reflect.get(value, "remote");
  if (remote !== undefined) {
    const parsed = parseRemoteAgentBinding(remote);
    if (parsed === undefined) return undefined;
    relay.remote = parsed;
  }
  const workflowAsk = Reflect.get(value, "workflowAsk");
  if (workflowAsk !== undefined) {
    const control = isRecord(workflowAsk) ? Reflect.get(workflowAsk, "control") : undefined;
    if (typeof control !== "string" || control.length === 0) return undefined;
    relay.workflowAsk = { control };
  }
  const runId = Reflect.get(value, "runId");
  if (runId !== undefined) {
    if (typeof runId !== "string" || runId.length === 0) return undefined;
    relay.runId = runId;
  }
  return relay;
}

function parseRemoteAgentBinding(
  value: unknown,
): (RemoteAgentBinding & { readonly sessionId: string }) | undefined {
  if (!isRecord(value)) return undefined;
  const name = Reflect.get(value, "name");
  const url = Reflect.get(value, "url");
  const resolverId = Reflect.get(value, "resolverId");
  const forwardPrincipal = Reflect.get(value, "forwardPrincipal");
  const sessionId = Reflect.get(value, "sessionId");
  // The parent's own step wrote it: the record its credentials render from.
  const dynamicBinding = Reflect.get(value, "dynamicBinding") as JsonValue | undefined;
  if (typeof name !== "string" || !name || typeof url !== "string" || !url) return undefined;
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  if (resolverId !== undefined && (typeof resolverId !== "string" || !resolverId)) return undefined;
  if (forwardPrincipal !== undefined && typeof forwardPrincipal !== "boolean") return undefined;
  return {
    name,
    url,
    sessionId,
    ...(resolverId !== undefined && { resolverId }),
    ...(forwardPrincipal !== undefined && { forwardPrincipal }),
    ...(dynamicBinding !== undefined && { dynamicBinding }),
  };
}

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
