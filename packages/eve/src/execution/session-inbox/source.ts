import {
  decodeDeliveryAddress,
  hookAddress,
  type DeliveryAddress,
  type InboxItem,
} from "#execution/durable.js";
import { createHookConflictError } from "#execution/hook-ownership.js";
import {
  logicalSessionInboxToken,
  logicalSessionToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import type {
  InboxHook,
  SessionInboxPayload,
  SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";

/** The result of a claim: the session holds the address, or another session holds it. */
export type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

/** The inbox of one session, as an engine keeps it. Pass it to {@link sessionInbox}. */
export interface SessionInboxSource {
  /** Returns up to `limit` items after `seq`, in the order of `seq`, with no gaps. */
  itemsAfter(seq: number, limit: number): Promise<readonly InboxItem[]>;
  /** Settles when a new item may be in the inbox. An early settle is harmless. */
  arrival(): Promise<void>;
  /** Claims an address for the session, so that deliveries to it reach this inbox. */
  claim(address: DeliveryAddress): Promise<ClaimResult>;
}

/** The inbox transport from {@link sessionInbox}, for `RunSessionHost.inbox`. */
export interface SessionInbox extends SessionInboxTransport<InboxHook & { stop(): void }> {
  /** Returns the `seq` of the last item that the transport gave to the session program. */
  yielded(): number;
}

const ITEMS_PAGE = 100;

/**
 * Makes the inbox transport of one session from the inbox that an engine keeps. `throughSeq` is the
 * position that the last record of the session consumed, or `0` at its first run.
 */
export function sessionInbox(
  sessionId: string,
  source: SessionInboxSource,
  options: { readonly throughSeq: number },
): SessionInbox {
  const command = sessionCommandHookToken(sessionId);
  const seqs = new WeakMap<object, number>();
  let next = options.throughSeq;
  return {
    yielded: () => next,
    open(token) {
      let stopped = false;
      let wakeHook: (() => void) | undefined;
      return {
        token,
        stop() {
          stopped = true;
          wakeHook?.();
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<SessionInboxPayload> {
          while (!stopped) {
            const items = token === command ? await source.itemsAfter(next, ITEMS_PAGE) : [];
            for (const item of items) {
              if (stopped) return;
              next = item.seq;
              const payload = structuredClone(inboxPayloadOf(item));
              seqs.set(payload, item.seq);
              for (const message of (payload as { messages?: object[] }).messages ?? [])
                seqs.set(message, item.seq);
              yield payload;
            }
            if (items.length > 0) continue;
            await new Promise<void>((resolve) => {
              wakeHook = resolve;
              void source.arrival().then(resolve);
            });
          }
        },
      };
    },
    async confirm(hook) {
      const claimed = await source.claim(canonicalAddress(hookAddress(hook.token)));
      if (!claimed.claimed) throw createHookConflictError(hook.token, claimed.heldBy);
    },
    async dispose(hook) {
      hook.stop();
    },
    consumedThrough: options.throughSeq,
    isTakenOver: () => false,
    ownerRunId: () => sessionId,
    now: () => Date.now(),
    seqOf: (payload) => seqs.get(payload),
  };
}

export function inboxPayloadOf(item: InboxItem): SessionInboxPayload {
  return item.body.kind === "deliver"
    ? (item.body.payload as SessionInboxPayload)
    : ({ kind: "cancel", deliveryId: item.id } as SessionInboxPayload);
}

/** Returns the canonical form of a delivery address so engines can index addresses by `key` without parsing it. */
export function canonicalAddress(to: DeliveryAddress): DeliveryAddress {
  const address = decodeDeliveryAddress(to);
  if (address.kind === "session") return hookAddress(logicalSessionToken(address.address));
  return hookAddress(logicalSessionInboxToken(address.token) ?? address.token);
}
