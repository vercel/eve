import { describe, expect, it } from "vitest";

import {
  cancelRoutedRun,
  installDurableHost,
  installedDurableHost,
  isRetriedStep,
  registerHost,
  registerSessionLineStore,
  resumeRoutedHook,
  resumeRoutedSessionInbox,
  routedRunEnded,
  routedRunLive,
  sessionLineStore,
  type DurableHost,
  type HostedRoute,
} from "#execution/hosts.js";
import {
  readSessionRecordHistory,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import { HookNotFoundError, isRunTargetGone, RunNotFoundError } from "#shared/run-errors.js";

/** A store holding fixed lines for every session it's registered for. */
function fixedStore(records: readonly unknown[]): SessionLineStore {
  const encoder = new TextEncoder();
  return {
    assertReadable: async () => {},
    readable: (_sessionId, startIndex = 0) =>
      new ReadableStream({
        start(controller) {
          for (const record of records.slice(startIndex))
            controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
          controller.close();
        },
      }),
    tail: async () => records.length - 1,
  };
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const records: unknown[] = [];
  for await (const record of stream) records.push(record);
  return records;
}

const delivery: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "Hi" }] };

/** What reaches the durable host below, and the attempt of the step it says is running. */
const durable = { reached: [] as string[], attempt: undefined as number | undefined };

function durableHost(name: string): DurableHost {
  return {
    name,
    resumeHook: async (token) => {
      durable.reached.push(`resume ${token}`);
    },
    resumeSessionInbox: async (address) => {
      durable.reached.push(`inbox ${typeof address === "string" ? address : address.sessionId}`);
    },
    runStatus: async (runId) => {
      if (runId === "run-gone") throw new HookNotFoundError(runId);
      if (runId === "run-unreadable") throw new Error("the World is down");
      return runId === "run-done" ? "completed" : "running";
    },
    cancelRun: async (runId) => {
      durable.reached.push(`cancel ${runId}`);
    },
    lineStore: fixedStore([{ line: "kept by the durable host" }]),
    stepAttempt: () => durable.attempt,
    createRuntime: () => {
      throw new Error("no runtime in this test");
    },
    connectionEvents: {
      start: async () => undefined,
      find: async () => undefined,
      retire: async (bindingId) => {
        durable.reached.push(`retire ${bindingId}`);
        return true;
      },
    },
  };
}

// The registry is process-wide and each test file has its own realm, so these run in order:
// first a realm with no durable host, then the same realm once one is installed.
describe("the hosts in a realm", () => {
  it("without a durable host, an id no route holds is gone and no step is a retry", async () => {
    await expect(resumeRoutedHook("hook-alice", {})).rejects.toThrow(HookNotFoundError);
    await expect(routedRunLive("run-bob")).resolves.toBe(false);
    // A run is gone as a run: not found by its id, which callers read as a target that's gone.
    await expect(routedRunEnded("run-bob")).resolves.toBe(true);
    const cancelled = await cancelRoutedRun("run-bob", "stop").catch((error: unknown) => error);
    expect(cancelled).toBeInstanceOf(RunNotFoundError);
    expect(cancelled).toMatchObject({ message: 'Run "run-bob" not found', runId: "run-bob" });
    expect(isRunTargetGone(cancelled)).toBe(true);
    expect(isRetriedStep()).toBe(false);
    expect(installedDurableHost()).toBeUndefined();
    expect(() => sessionLineStore("session-alice")).toThrow(
      'No host in this realm holds session "session-alice".',
    );
  });

  it("keeps the first durable host, and refuses a different one", () => {
    installDurableHost(durableHost("durable"));
    // Another copy of the same host, as a step bundle's copy of eve's modules builds.
    installDurableHost(durableHost("durable"));
    expect(() => installDurableHost(durableHost("other"))).toThrow(
      `This realm's durable host is "durable"; "other" can't replace it.`,
    );
    // What only a durable host keeps (scheduled runs, event watches) is asked of the one installed.
    expect(installedDurableHost()?.name).toBe("durable");
  });

  it("reads whether the step running now is a retry from the durable host", () => {
    durable.attempt = 1;
    expect(isRetriedStep()).toBe(false);
    durable.attempt = 2;
    expect(isRetriedStep()).toBe(true);
    durable.attempt = undefined;
    expect(isRetriedStep()).toBe(false);
  });

  it("asks the routes first, and the durable host for what no route holds", async () => {
    const delivered: string[] = [];
    const route: HostedRoute = {
      deliver: async (token) => {
        if (token === "hook-gone") return "gone";
        // A session's inbox, held here, by its logical token.
        if (token === sessionInboxHookToken(sessionCommandHookToken("session-alice"))) {
          delivered.push("inbox session-alice");
          return "delivered";
        }
        if (token !== "hook-held") return undefined;
        delivered.push(token);
        return "delivered";
      },
      runEnded: (runId) => (runId === "run-held" ? true : undefined),
      cancelRun: (runId) => (runId === "run-held" ? true : undefined),
    };
    const release = registerHost(route);
    try {
      await resumeRoutedHook("hook-held", {});
      await expect(resumeRoutedHook("hook-gone", {})).rejects.toThrow(HookNotFoundError);
      await expect(routedRunEnded("run-held")).resolves.toBe(true);
      await expect(routedRunLive("run-held")).resolves.toBe(false);
      await cancelRoutedRun("run-held", "stop");
      await resumeRoutedSessionInbox({ sessionId: "session-alice" }, delivery);
      expect(delivered).toEqual(["hook-held", "inbox session-alice"]);
      expect(durable.reached).toEqual([]);

      await resumeRoutedHook("hook-durable", {});
      await cancelRoutedRun("run-durable", "stop");
      await resumeRoutedSessionInbox({ sessionId: "session-bob" }, delivery);
      expect(durable.reached).toEqual([
        "resume hook-durable",
        "cancel run-durable",
        "inbox session-bob",
      ]);
    } finally {
      release();
    }
  });

  it("reads a durable run's end and liveness from its status", async () => {
    await expect(routedRunEnded("run-done")).resolves.toBe(true);
    await expect(routedRunEnded("run-open")).resolves.toBe(false);
    // A target that's gone has ended; one whose status can't be read is still live.
    await expect(routedRunEnded("run-gone")).resolves.toBe(true);
    await expect(routedRunEnded("run-unreadable")).rejects.toThrow("the World is down");
    await expect(routedRunLive("run-open")).resolves.toBe(true);
    await expect(routedRunLive("run-gone")).resolves.toBe(false);
    await expect(routedRunLive("run-unreadable")).resolves.toBe(true);
  });

  it("reads a registered session from its store, and the durable host's once released", async () => {
    const store = fixedStore([{ line: "Alice" }, { line: "Bob" }]);
    const release = registerSessionLineStore("session-alice", store);
    try {
      expect(sessionLineStore("session-alice")).toBe(store);
      await expect(readSessionStreamTailIndex("session-alice")).resolves.toBe(1);
      await expect(readAll(readSessionRecordHistory("session-alice", -1))).resolves.toEqual([
        { line: "Bob" },
      ]);
    } finally {
      release();
    }
    await expect(readAll(readSessionRecordHistory("session-alice", 0))).resolves.toEqual([
      { line: "kept by the durable host" },
    ]);
  });

  it("refuses a second store for the same session", () => {
    const release = registerSessionLineStore("session-alice", fixedStore([]));
    try {
      expect(() => registerSessionLineStore("session-alice", fixedStore([]))).toThrow(
        'Session "session-alice" already has a line store.',
      );
    } finally {
      release();
    }
  });
});
