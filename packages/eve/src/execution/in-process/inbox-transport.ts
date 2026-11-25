import { createHookConflictError } from "#execution/hook-ownership.js";
import type {
  InboxHook,
  SessionInboxPayload,
  SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";
import type { WorkflowToolRunMessageBatch } from "#execution/tools/workflow/messages.js";
import type { RunHook } from "#execution/run-host.js";
import { received, type Crossing, type StepBoundary } from "./step-boundary.js";

export type DeliveryTiming = "immediate" | "batched";

export type Arrival = SessionInboxPayload | WorkflowToolRunMessageBatch;

export type Keep<T> = (token: string, payload: T) => Promise<void>;

export type Delivery =
  | { readonly kind: "delivered"; readonly owner: string }
  | { readonly kind: "gone" }
  | undefined;

interface Address<T> {
  readonly owner: string;
  readonly queue: T[];
  readonly pending: T[];
  readonly waiters: Set<() => void>;
  pulled: (() => void) | undefined;
  disposed: boolean;
  accept(crossing: Crossing, options: { readonly keep: boolean }): Promise<void>;
}

interface MemoryHook extends InboxHook {
  readonly address: Address<Arrival>;
}

interface Reservation {
  readonly owner: string;
  readonly matches: (token: string) => boolean;
  readonly keep: Keep<unknown>;
  readonly early: Map<string, Crossing[]>;
}

export interface MemoryInboxRegistry {
  transportFor(
    sessionId: string,
    options?: { readonly keep?: Keep<Arrival> },
  ): SessionInboxTransport<MemoryHook>;
  openHook<T>(owner: string, token: string, options: { readonly keep: Keep<unknown> }): RunHook<T>;
  reserve(
    owner: string,
    tokens: { readonly prefix: string } | { readonly token: string },
    options: { readonly keep: Keep<unknown> },
  ): () => void;
  deliver(token: string, payload: unknown): Promise<Delivery>;
  holder(token: string): string | undefined;
  holdsAny(owner: string): boolean;
  closeAll(): void;
  heard(): Promise<void>;
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createMemoryInboxRegistry(
  boundary: StepBoundary,
  options: { readonly deliveries?: DeliveryTiming } = {},
): MemoryInboxRegistry {
  const held = new Map<string, Address<unknown>>();
  const sessionAddresses = new Map<string, Address<Arrival>>();
  const opened = new Set<Address<unknown>>();
  const everHeld = new Set<string>();
  const reservations = new Set<Reservation>();
  let closed = false;
  const lanes = new Map<string, Promise<unknown>>();

  const wake = (address: Address<unknown>): void => {
    for (const resolve of address.waiters) resolve();
    address.waiters.clear();
  };
  const arrivals: Address<unknown>[] = [];
  let flushing: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    await nextMacrotask();
    while (arrivals.length > 0) {
      const address = arrivals.shift()!;
      const payload = address.pending.shift();
      if (payload === undefined) continue;
      address.queue.push(payload);
      if (address.waiters.size === 0) continue;
      const pulled = new Promise<void>((resolve) => (address.pulled = resolve));
      wake(address);
      await Promise.race([pulled, nextMacrotask()]);
      address.pulled = undefined;
    }
    flushing = undefined;
  };
  const arrived = (address: Address<unknown>, payload: unknown): void => {
    if (options.deliveries !== "batched") {
      address.queue.push(payload);
      return wake(address);
    }
    address.pending.push(payload);
    arrivals.push(address);
    flushing ??= flush();
  };
  const close = (token: string, address: Address<unknown>): void => {
    address.queue.push(...address.pending.splice(0));
    address.disposed = true;
    opened.delete(address);
    wake(address);
    if (held.get(token) === address) held.delete(token);
    if (sessionAddresses.get(token) === address) sessionAddresses.delete(token);
  };
  const hold = (token: string, address: Address<unknown>): void => {
    held.set(token, address);
    everHeld.add(token);
  };
  const reservationFor = (token: string) =>
    [...reservations].find((reservation) => reservation.matches(token));
  const inLane = async <T>(token: string, run: () => Promise<T>): Promise<T> => {
    const before = lanes.get(token) ?? Promise.resolve();
    const next = before.then(run, run);
    const tail = next.catch(() => {});
    lanes.set(token, tail);
    try {
      return await next;
    } finally {
      if (lanes.get(token) === tail) lanes.delete(token);
    }
  };

  const address = <T>(
    owner: string,
    token: string,
    keep: Keep<T> | undefined,
  ): Address<T> & AsyncIterable<T> => {
    const created: Address<T> & AsyncIterable<T> = {
      disposed: closed,
      owner,
      queue: [],
      pending: [],
      waiters: new Set(),
      pulled: undefined,
      async accept(crossing, options) {
        const payload = await received<T>(boundary, crossing);
        if (options.keep) await keep?.(token, payload);
        arrived(created, payload);
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = created.queue.shift();
          if (next !== undefined) {
            yield next;
            created.pulled?.();
            continue;
          }
          if (created.disposed) return;
          await new Promise<void>((resolve) => created.waiters.add(resolve));
        }
      },
    };
    opened.add(created);
    return created;
  };

  return {
    holder: (token) => held.get(token)?.owner,
    async heard() {
      if (options.deliveries !== "batched") return;
      await nextMacrotask();
      while (flushing !== undefined) await flushing;
    },
    holdsAny: (owner) => [...held.values()].some((address) => address.owner === owner),

    async deliver(token, payload) {
      return await inLane(token, async (): Promise<Delivery> => {
        const holder = held.get(token);
        if (holder !== undefined) {
          await holder.accept(await boundary.send(payload), { keep: true });
          return { kind: "delivered", owner: holder.owner };
        }
        const reservation = reservationFor(token);
        if (reservation !== undefined) {
          const crossing = await boundary.send(payload);
          await reservation.keep(token, await boundary.receive(crossing));
          reservation.early.set(token, [...(reservation.early.get(token) ?? []), crossing]);
          return { kind: "delivered", owner: reservation.owner };
        }
        return everHeld.has(token) ? { kind: "gone" } : undefined;
      });
    },

    reserve(owner, tokens, options) {
      const reservation: Reservation = {
        early: new Map(),
        keep: options.keep,
        matches:
          "prefix" in tokens
            ? (token) => token.startsWith(tokens.prefix)
            : (token) => token === tokens.token,
        owner,
      };
      reservations.add(reservation);
      return () => {
        reservations.delete(reservation);
      };
    },

    openHook<T>(owner: string, token: string, options: { readonly keep: Keep<unknown> }) {
      const claimed = !held.has(token);
      const hook = address<T>(owner, token, options.keep);
      if (claimed) hold(token, hook);
      const reservation = reservationFor(token);
      const early = reservation?.early.get(token) ?? [];
      reservation?.early.delete(token);
      const reading = early.reduce<Promise<void>>(
        (before, crossing) => before.then(() => hook.accept(crossing, { keep: false })),
        Promise.resolve(),
      );
      return {
        token,
        claim: async () => {
          await reading;
          return claimed;
        },
        dispose: async () => {
          close(token, hook);
        },
        [Symbol.asyncIterator]: () => hook[Symbol.asyncIterator](),
      };
    },

    closeAll() {
      closed = true;
      for (const open of opened) {
        open.queue.push(...open.pending.splice(0));
        open.disposed = true;
        wake(open);
      }
      opened.clear();
      held.clear();
      sessionAddresses.clear();
    },

    transportFor(sessionId, options = {}) {
      return {
        open(token) {
          const opening = address<Arrival>(sessionId, token, options.keep);
          return {
            address: opening,
            token,
            [Symbol.asyncIterator]: () => opening[Symbol.asyncIterator](),
          };
        },
        async confirm(hook) {
          const current = held.get(hook.token);
          if (current !== undefined && current.owner !== sessionId)
            throw createHookConflictError(hook.token, current.owner);
          hold(hook.token, hook.address);
          sessionAddresses.set(hook.token, hook.address);
        },
        async dispose(hook) {
          close(hook.token, hook.address);
        },
        isTakenOver: () => false,
        ownerRunId: () => sessionId,
        now: () => Date.now(),
      };
    },
  };
}
