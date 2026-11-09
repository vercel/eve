import type {
  InboxHook,
  SessionInboxPayload,
  SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";
import type { WorkflowToolRunMessageBatch } from "#execution/tools/workflow/messages.js";
import type { RunHook } from "#execution/run-host.js";
import { received, type Crossing, type StepBoundary } from "./step-boundary.js";

// Addresses in memory: a token names at most one open address, which its owner (a session, or a
// run) reads in order. What arrives crosses the step boundary, as a hook payload does on
// Workflow, and its owner keeps it before it's queued (`keep`), so an owner that goes on after a
// crash has it. An owner can reserve tokens it opens later; what arrives for one waits, kept,
// until it opens. Nothing here survives the process.

/** What a session's address reads. */
export type Arrival = SessionInboxPayload | WorkflowToolRunMessageBatch;

/** Keeps what arrived at `token` before its owner reads it. */
export type Keep<T> = (token: string, payload: T) => Promise<void>;

/** Where a delivery went: to `owner`, or nowhere, for a token held once and closed since. */
export type Delivery =
  | { readonly kind: "delivered"; readonly owner: string }
  | { readonly kind: "gone" }
  | undefined;

/** One open address and what it does with what arrives. */
interface Address<T> {
  readonly owner: string;
  readonly queue: T[];
  readonly waiters: Set<() => void>;
  disposed: boolean;
  /** Reads `crossing` as the address's own payload, keeps it when asked, and queues it. */
  accept(crossing: Crossing, options: { readonly keep: boolean }): Promise<void>;
}

interface MemoryHook extends InboxHook {
  readonly address: Address<Arrival>;
}

/** Tokens an owner opens later: one, or every token under a prefix. */
interface Reservation {
  readonly owner: string;
  readonly matches: (token: string) => boolean;
  readonly keep: Keep<unknown>;
  /** What arrived before each token opened, by token, kept already. */
  readonly early: Map<string, Crossing[]>;
}

export interface MemoryInboxRegistry {
  /** The transport one session's inbox opens its addresses with, which keeps through `keep`. */
  transportFor(
    sessionId: string,
    options?: { readonly keep?: Keep<Arrival> },
  ): SessionInboxTransport<MemoryHook>;
  /** Opens a run's hook at `token`, which keeps through `keep` and reads what waited for it. */
  openHook<T>(owner: string, token: string, options: { readonly keep: Keep<unknown> }): RunHook<T>;
  /**
   * Reserves `tokens` for `owner`, which opens them later (`openHook`): what arrives first is
   * kept through `keep`, and waits. The returned release ends the reservation.
   */
  reserve(
    owner: string,
    tokens: { readonly prefix: string } | { readonly token: string },
    options: { readonly keep: Keep<unknown> },
  ): () => void;
  /** Delivers `payload` to `token`, kept by its owner first. */
  deliver(token: string, payload: unknown): Promise<Delivery>;
  /** Queues at a session's address what its session kept already, as it kept it: a restore's. */
  requeue(token: string, arrival: Arrival): void;
  /** Queues at a run's hook what the run kept already: a resumed run's, as it reads it again. */
  replay(token: string, payload: unknown): Promise<void>;
  /** The owner of the address `token` names, if one is open. */
  holder(token: string): string | undefined;
  /** Closes every open address, so each owner reads nothing more. */
  closeAll(): void;
}

/** Addresses whose payloads cross `boundary` once each, as hook payloads cross Workflow's. */
export function createMemoryInboxRegistry(boundary: StepBoundary): MemoryInboxRegistry {
  const held = new Map<string, Address<unknown>>();
  const sessionAddresses = new Map<string, Address<Arrival>>();
  const opened = new Set<Address<unknown>>();
  const everHeld = new Set<string>();
  const reservations = new Set<Reservation>();
  // Deliveries to one token cross the boundary in the order they were made.
  const lanes = new Map<string, Promise<unknown>>();

  const wake = (address: Address<unknown>): void => {
    for (const resolve of address.waiters) resolve();
    address.waiters.clear();
  };
  const close = (token: string, address: Address<unknown>): void => {
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
      // The lane ends with its last delivery, so an idle registry holds none.
      if (lanes.get(token) === tail) lanes.delete(token);
    }
  };

  const address = <T>(
    owner: string,
    token: string,
    keep: Keep<T> | undefined,
  ): Address<T> & AsyncIterable<T> => {
    const created: Address<T> & AsyncIterable<T> = {
      disposed: false,
      owner,
      queue: [],
      waiters: new Set(),
      async accept(crossing, options) {
        const payload = await received<T>(boundary, crossing);
        if (options.keep) await keep?.(token, payload);
        created.queue.push(payload);
        wake(created);
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = created.queue.shift();
          if (next !== undefined) {
            yield next;
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

    requeue(token, arrival) {
      const target = sessionAddresses.get(token);
      if (target === undefined) throw new Error(`No session holds the address "${token}".`);
      target.queue.push(arrival);
      wake(target);
    },

    async replay(token, payload) {
      const holder = held.get(token);
      if (holder === undefined) throw new Error(`No run holds the hook "${token}".`);
      await holder.accept(await boundary.send(payload), { keep: false });
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
      // What waited for the hook was kept when it arrived; it's read now, in order.
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
      for (const open of opened) {
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
            throw new Error(`Session address "${hook.token}" belongs to another session.`);
          hold(hook.token, hook.address);
          sessionAddresses.set(hook.token, hook.address);
        },
        async dispose(hook) {
          close(hook.token, hook.address);
        },
        // Nothing here takes an address from the session that holds it.
        isTakenOver: () => false,
        // One owner per session, for as long as this process runs it.
        ownerRunId: () => sessionId,
      };
    },
  };
}
