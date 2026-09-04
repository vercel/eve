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

export function replyTargetToken(target: ReplyTarget): string {
  return target.kind === "inbox" ? target.address.token : target.token;
}
