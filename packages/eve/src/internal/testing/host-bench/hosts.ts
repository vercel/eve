import type { TestSessionHostKind } from "#internal/testing/test-session-hosts.js";
import {
  inProcessHost,
  inProcessWorldHost,
  inProcessWorldRestartHost,
  worldHost,
  type SessionHostKind,
  workflowHost,
} from "#internal/testing/session-host/host-under-test.js";
import { currentTestWorld } from "#internal/testing/workflow-test-world.js";

// The hosts the bench measures. A host is the host battery's `SessionHostKind` (how to make one
// for a case) plus, optionally, counters that explain where its time goes. Adding a host is one
// entry here, or one entry in the record a caller passes to `runHostBench`.

/** Cumulative counts of what a host did since `count()` started them. */
export interface BenchCounters {
  read(): Record<string, number>;
  /** Stops counting and puts back what `count()` wrapped. */
  restore(): void;
}

export interface BenchHost {
  readonly kind: SessionHostKind;
  /** Starts counting the host's own work, such as the events its store writes. */
  readonly count?: () => BenchCounters;
}

export const BENCH_HOSTS: Readonly<Record<string, BenchHost>> = {
  workflow: { kind: workflowHost, count: countWorldCalls },
  "in-process": { kind: inProcessHost },
  "in-process+world": { kind: inProcessWorldHost },
  "in-process-world-restart": { kind: inProcessWorldRestartHost },
  world: { kind: worldHost },
} satisfies Record<TestSessionHostKind | "in-process+world", BenchHost>;

/**
 * Counts what the test file's Workflow World is asked to do: queue messages (each a delivery to a
 * flow or step handler), events written and read back (a run's replay loads its log), and stream
 * writes. It wraps the World's methods in place, as the host battery's fault plans do.
 */
function countWorldCalls(): BenchCounters {
  const { world } = currentTestWorld();
  const counts: Record<string, number> = {};
  const add = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const restores: (() => void)[] = [];
  type Fn = (...args: any[]) => any;
  const wrap = (target: object, key: string, around: (original: Fn) => Fn) => {
    const methods = target as Record<string, unknown>;
    const original = methods[key];
    if (typeof original !== "function") return;
    const own = Object.prototype.hasOwnProperty.call(target, key);
    methods[key] = around((original as Fn).bind(target));
    restores.push(() => {
      if (own) methods[key] = original;
      else delete methods[key];
    });
  };
  /** Runs `call`, adding the time it took to `<key>.ms`. */
  const timed = async <T>(key: string, call: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await call();
    } finally {
      add(`${key}.ms`, performance.now() - start);
    }
  };
  const countEvent = (event: { readonly eventType?: string }) => {
    add("world.events.written");
    add(`world.event.${event.eventType ?? "unknown"}`);
  };

  wrap(world, "queue", (original) => async (...args: unknown[]) => {
    add("world.queue.messages");
    return await timed("world.queue", () => original(...args));
  });
  wrap(world.events, "create", (original) => async (...args: unknown[]) => {
    add("world.events.writeCalls");
    countEvent(args[1] as { eventType?: string });
    return await timed("world.events.write", () => original(...args));
  });
  wrap(world.events, "createBatch", (original) => async (...args: unknown[]) => {
    add("world.events.writeCalls");
    for (const event of args[1] as { eventType?: string }[]) countEvent(event);
    return await timed("world.events.write", () => original(...args));
  });
  wrap(world.events, "list", (original) => async (...args: unknown[]) => {
    add("world.events.listCalls");
    const page = (await timed("world.events.list", () => original(...args))) as {
      readonly data?: readonly unknown[];
    };
    add("world.events.listed", page.data?.length ?? 0);
    return page;
  });
  wrap(world.streams, "write", (original) => async (...args: unknown[]) => {
    add("world.streams.writeCalls");
    return await timed("world.streams.write", () => original(...args));
  });
  wrap(world.streams, "writeMulti", (original) => async (...args: unknown[]) => {
    add("world.streams.writeCalls");
    return await timed("world.streams.write", () => original(...args));
  });
  // Reads include the bench's own follow of the session stream, one per turn.
  wrap(world.streams, "get", (original) => async (...args: unknown[]) => {
    add("world.streams.gets");
    return await timed("world.streams.get", () => original(...args));
  });
  wrap(world.streams, "getChunks", (original) => async (...args: unknown[]) => {
    add("world.streams.chunkPageReads");
    const page = (await original(...args)) as { readonly data?: readonly unknown[] };
    add("world.streams.chunksRead", page.data?.length ?? 0);
    return page;
  });
  wrap(world.streams, "getInfo", (original) => async (...args: unknown[]) => {
    add("world.streams.infoReads");
    return await original(...args);
  });
  wrap(world.streams, "createWriteSession", (original) => (...args: unknown[]) => {
    add("world.streams.writeSessions");
    const session = original(...args) as { write: Fn };
    const write = session.write.bind(session);
    session.write = async (...writeArgs: unknown[]) => {
      add("world.streams.writeCalls");
      return await timed("world.streams.write", () => write(...writeArgs));
    };
    return session;
  });

  return {
    read: () => ({ ...counts }),
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}
