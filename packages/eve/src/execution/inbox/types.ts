export interface InboxAddress {
  readonly token: string;
  readonly ownerRunId: string;
}

export interface InboxEnvelope<T = unknown> {
  readonly eventId: string;
  readonly kind: string;
  readonly payload: T;
  readonly requestId?: string;
  readonly target?: {
    readonly ownerRunId: string;
    readonly turnId?: string;
    readonly operationId?: string;
  };
}

export type InboxClaim =
  | { readonly kind: "owned" }
  | { readonly kind: "conflict"; readonly runId: string };

export interface OwnerInbox<T extends InboxEnvelope = InboxEnvelope> {
  readonly address: InboxAddress;
  claim(): Promise<InboxClaim>;
  drain(): T[];
  next(): Promise<T>;
  response(requestId: string, signal?: AbortSignal): Promise<T>;
  observe(listener: (envelope: T) => void, onError?: (error: unknown) => void): () => void;
  dispose(): Promise<void>;
}

export interface InboxReplyTarget {
  readonly kind: "inbox";
  readonly address: InboxAddress;
  readonly requestId: string;
}

export type ReplyTarget = InboxReplyTarget | { readonly kind: "session"; readonly token: string };

export function isReplyTarget(value: unknown): value is ReplyTarget {
  if (value === null || typeof value !== "object") return false;
  const target = value as Partial<ReplyTarget>;
  if (target.kind === "session") return typeof target.token === "string" && target.token.length > 0;
  return (
    target.kind === "inbox" &&
    typeof target.requestId === "string" &&
    target.requestId.length > 0 &&
    target.address !== null &&
    typeof target.address === "object" &&
    typeof target.address.token === "string" &&
    target.address.token.length > 0 &&
    typeof target.address.ownerRunId === "string" &&
    target.address.ownerRunId.length > 0
  );
}

export function replyTargetToken(target: ReplyTarget): string {
  return target.kind === "inbox" ? target.address.token : target.token;
}
