import { AliasTakenError, type Entities, TakenOverError } from "#execution/entity/entities.js";
import { worldEntities } from "#execution/entity/world/world-entities.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import type { ScheduleExpression, ScheduleState } from "#public/schedules/subscription.js";

// The dynamic schedules a World keeps (`worldScheduleProvider`): one entity per World holds them
// all, found by an alias, as a table its every change saves whole (a few schedules per agent, so
// small). A change opens the entity, which fences out whoever changed it before, reads the table,
// applies the change and saves it; a change another process fenced out meanwhile is made again on
// what that one saved. A World host fires what's due on its `tick`.

const STORE_ALIAS = "eve-world-schedules";
const TABLE_RECORD = "eve.schedules";
/** How many operation results the table keeps, so a retried operation returns what it did. */
const KEPT_OPERATIONS = 200;
const CHANGE_ATTEMPTS = 5;

export interface StoredWorldSchedule {
  readonly application: string;
  readonly collection: string;
  readonly namespace: string;
  readonly name: string;
  readonly scheduleId: string;
  readonly displayName?: string;
  readonly expression: ScheduleExpression;
  readonly payload: unknown;
  readonly state: ScheduleState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An occurrence a tick found due, kept until a dispatch of it succeeds or gives up. */
export interface PendingOccurrence {
  /** The schedule's `scheduleKey`, and which schedule that was then. */
  readonly key: string;
  readonly scheduleId: string;
  /** The minute it's due in (epoch milliseconds). */
  readonly minute: number;
  /** Dispatches started so far. */
  readonly attempts: number;
  /** Until when the one dispatching it holds it (epoch milliseconds); 0: no one does. */
  readonly leaseUntil: number;
}

export interface ScheduleTable {
  /** By `scheduleKey`. */
  schedules: Record<string, StoredWorldSchedule>;
  /** By the occurrence's execution id. Absent in a table saved before there were any. */
  pending?: Record<string, PendingOccurrence>;
  /** What each recent operation returned, oldest first. */
  operations: [string, unknown][];
}

export function scheduleKey(collection: string, namespace: string, name: string): string {
  return `${collection}\0${namespace}\0${name}`;
}

export interface ScheduleStore {
  read(): Promise<ScheduleTable>;
  /**
   * Applies `change` to the table and saves it. With `operationId`, a repeat returns what the
   * first did, without changing the table again.
   */
  change<T>(change: (table: ScheduleTable) => T, operationId?: string): Promise<T>;
}

export function worldScheduleStore(world: RuntimeWorld): ScheduleStore {
  const entities: Entities = worldEntities(world, {
    kind: "schedules",
    streamNamespace: "eve-schedules",
    workflowName: "eve/world-schedules",
  });
  let key: Promise<string> | undefined;
  /** The table's entity: found by its alias, or created with it by the first to need it. */
  const keyOf = (create: boolean): Promise<string | undefined> => {
    if (key !== undefined) return key;
    return (async () => {
      const found = await entities.lookup(STORE_ALIAS);
      if (found !== undefined) return ((key = Promise.resolve(found)), found);
      if (!create) return undefined;
      const fresh = entities.newKey();
      try {
        await entities.create(fresh, { aliases: [STORE_ALIAS], meta: {} });
      } catch (error) {
        // Another process created it first: that one is the table.
        if (!(error instanceof AliasTakenError)) throw error;
        const winner = await entities.lookup(STORE_ALIAS);
        if (winner === undefined) throw error;
        key = Promise.resolve(winner);
        return winner;
      }
      key = Promise.resolve(fresh);
      return fresh;
    })();
  };
  const empty = (): ScheduleTable => ({ operations: [], schedules: {} });
  return {
    async read() {
      const found = await keyOf(false);
      if (found === undefined) return empty();
      const journal = await entities.load(found);
      return structuredClone((journal?.snapshot?.value as ScheduleTable | undefined) ?? empty());
    },
    async change(change, operationId) {
      const found = (await keyOf(true))!;
      for (let attempt = 1; ; attempt += 1) {
        const handle = await entities.open(found);
        const journal = await handle.load();
        const table = structuredClone(
          (journal.snapshot?.value as ScheduleTable | undefined) ?? empty(),
        );
        const done =
          operationId === undefined
            ? undefined
            : table.operations.find(([id]) => id === operationId);
        if (done !== undefined) return done[1] as ReturnType<typeof change>;
        const result = change(table);
        if (operationId !== undefined) {
          table.operations.push([operationId, result]);
          table.operations.splice(0, Math.max(0, table.operations.length - KEPT_OPERATIONS));
        }
        try {
          await handle.append([{ kind: TABLE_RECORD, value: table }], { snapshot: true });
          return result;
        } catch (error) {
          if (!(error instanceof TakenOverError) || attempt >= CHANGE_ATTEMPTS) throw error;
        }
      }
    },
  };
}

// The store a World host in this realm keeps its schedules in, for `worldScheduleProvider`.
const STORE = Symbol.for("eve.world-schedules");

/** Makes `store` the one this realm's World schedule providers use, until the returned release. */
export function registerWorldScheduleStore(store: ScheduleStore): () => void {
  const holder = globalThis as { [STORE]?: ScheduleStore };
  holder[STORE] = store;
  return () => {
    if (holder[STORE] === store) holder[STORE] = undefined;
  };
}

export function registeredWorldScheduleStore(): ScheduleStore | undefined {
  return (globalThis as { [STORE]?: ScheduleStore })[STORE];
}
