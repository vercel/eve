import type { JsonValue } from "#shared/json.js";
import type { RelayRoute } from "#channel/types.js";
import { isSessionInboxAddress } from "#execution/session-inbox/address.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

export interface WorkflowAskRoute {
  readonly control: string;
}

export interface Relay extends RelayRoute {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly runId?: string;
  readonly receipts?: Readonly<Record<string, string>>;
}

const FORWARDED_SHARE = /^(.+)_forwarded_\d+$/;

export function forwardedShareId(deliveryId: string, share: number): string {
  return share === 0 ? deliveryId : `${deliveryId}_forwarded_${share}`;
}

export function forwardedFrom(deliveryId: string): string {
  return FORWARDED_SHARE.exec(deliveryId)?.[1] ?? deliveryId;
}

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
  const receipts = Reflect.get(value, "receipts");
  if (isRecord(receipts) && Object.values(receipts).every((id) => typeof id === "string"))
    relay.receipts = receipts as Record<string, string>;
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
  const dynamicBinding = Reflect.get(value, "dynamicBinding") as JsonValue | undefined;
  const earlierProtocol = Reflect.get(value, "earlierProtocol");
  if (
    earlierProtocol !== undefined &&
    (typeof earlierProtocol !== "number" || !Number.isInteger(earlierProtocol))
  )
    return undefined;
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
    ...(earlierProtocol !== undefined && { earlierProtocol }),
  };
}

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
