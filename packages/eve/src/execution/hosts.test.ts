import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelRoutedRun,
  installProcessEngine,
  installedDurable,
  installedProcessEngine,
  isRetriedStep,
  registerHost,
  registerSessionEventStore,
  resumeRoutedHook,
  resumeRoutedSessionInbox,
  routedRunEnded,
  routedRunLive,
  sessionEventStore,
  sessionSignInCallbacks,
  type HostedRoute,
  type ProcessEngine,
} from "#execution/hosts.js";
import { decodeDeliveryAddress, type Durable } from "#execution/durable.js";
import {
  readSessionRecordHistory,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import { resetTestRealm } from "#internal/testing/reset-test-realm.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { HookNotFoundError } from "#shared/run-errors.js";

function fixedStore(records: readonly unknown[]): SessionEventStore {
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

const durable = {
  reached: [] as string[],
  attempt: undefined as number | undefined,
  callbackBaseUrl: undefined as string | undefined,
};

function processEngine(name: string): ProcessEngine {
  return {
    name,
    durable: {
      start: async () => {},
      deliver: async (to) => {
        const address = decodeDeliveryAddress(to);
        if (address.kind === "hook") durable.reached.push(`resume ${address.token}`);
        else if (address.kind === "session")
          durable.reached.push(
            `inbox ${typeof address.address === "string" ? address.address : address.address.sessionId}`,
          );
      },
      readStream: async function* () {},
      tail: async () => -1,
      status: async () => undefined,
    },
    deploymentId: async () => "dpl_durable",
    runStatus: async (runId) => {
      if (runId === "run-gone") throw new HookNotFoundError(runId);
      if (runId === "run-unreadable") throw new Error("the World is down");
      return runId === "run-done" ? "completed" : "running";
    },
    cancelRun: async (runId) => {
      durable.reached.push(`cancel ${runId}`);
    },
    sessionEvents: fixedStore([{ line: "kept by the durable host" }]),
    stepAttempt: () => durable.attempt,
    callbackBaseUrl: () => durable.callbackBaseUrl,
  };
}

describe("the hosts in a realm", () => {
  beforeEach(() => {
    resetTestRealm();
    durable.reached = [];
    durable.attempt = undefined;
    durable.callbackBaseUrl = undefined;
  });

  it("without a durable host, an id no route holds is gone and no step is a retry", async () => {
    await expect(resumeRoutedHook("hook-alice", {})).rejects.toThrow(HookNotFoundError);
    await expect(routedRunLive("run-bob")).resolves.toBe(false);
    await expect(routedRunEnded("run-bob")).resolves.toBe(true);
    expect(isRetriedStep()).toBe(false);
    expect(installedDurable()).toBeUndefined();
    expect(() => sessionEventStore("session-alice")).toThrow(
      'No host in this realm holds session "session-alice".',
    );
  });

  it("keeps the first durable engine, and refuses a different one", () => {
    const first = processEngine("durable");
    installProcessEngine(first);
    expect(installProcessEngine(processEngine("durable"))).toBe(first);
    expect(() => installProcessEngine(processEngine("other"))).toThrow(
      `This realm's durable engine is "durable"; "other" can't replace it.`,
    );
    expect(installedProcessEngine()).toBe(first);
    expect(installedDurable()).toBe(first.durable);
  });

  it("reads whether the step running now is a retry from the durable host", () => {
    installProcessEngine(processEngine("durable"));
    durable.attempt = 1;
    expect(isRetriedStep()).toBe(false);
    durable.attempt = 2;
    expect(isRetriedStep()).toBe(true);
    durable.attempt = undefined;
    expect(isRetriedStep()).toBe(false);
  });

  it("asks the route running a session how it's called back, and the durable host for others", () => {
    installProcessEngine(processEngine("durable"));
    const deliver: Durable["deliver"] = async () => {};
    const release = registerHost({
      deliver: async () => undefined,
      runEnded: () => undefined,
      cancelRun: () => undefined,
      signInCallbacks: (sessionId) =>
        sessionId === "session-alice"
          ? { callbackBaseUrl: "http://alice.example", deliver }
          : undefined,
    });
    try {
      expect(sessionSignInCallbacks("session-alice")).toEqual({
        callbackBaseUrl: "http://alice.example",
        deliver,
      });
      expect(sessionSignInCallbacks("session-bob")).toBeUndefined();
      durable.callbackBaseUrl = "https://bob.example";
      expect(sessionSignInCallbacks("session-bob")?.callbackBaseUrl).toBe("https://bob.example");
    } finally {
      durable.callbackBaseUrl = undefined;
      release();
    }
  });

  it("asks the routes first, and the durable host for what no route holds", async () => {
    installProcessEngine(processEngine("durable"));
    const delivered: string[] = [];
    const route: HostedRoute = {
      deliver: async (token) => {
        if (token === "hook-gone") return "gone";
        if (token === sessionInboxHookToken(sessionCommandHookToken("session-alice"))) {
          delivered.push("inbox session-alice");
          return "delivered";
        }
        if (token !== "hook-held") return undefined;
        delivered.push(token);
        return "delivered";
      },
      runEnded: (runId) => (runId === "run-held" ? true : undefined),
      cancelRun: (runId) =>
        runId === "run-held" ? true : runId === "run-held-ended" ? false : undefined,
    };
    const release = registerHost(route);
    try {
      await resumeRoutedHook("hook-held", {});
      await expect(resumeRoutedHook("hook-gone", {})).rejects.toThrow(HookNotFoundError);
      await expect(routedRunEnded("run-held")).resolves.toBe(true);
      await expect(routedRunLive("run-held")).resolves.toBe(false);
      await expect(cancelRoutedRun("run-held", "stop")).resolves.toBe(true);
      await expect(cancelRoutedRun("run-held-ended", "stop")).resolves.toBe(false);
      await resumeRoutedSessionInbox({ sessionId: "session-alice" }, delivery);
      expect(delivered).toEqual(["hook-held", "inbox session-alice"]);
      expect(durable.reached).toEqual([]);

      await resumeRoutedHook("hook-durable", {});
      await expect(cancelRoutedRun("run-durable", "stop")).resolves.toBe(true);
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
    installProcessEngine(processEngine("durable"));
    await expect(routedRunEnded("run-done")).resolves.toBe(true);
    await expect(routedRunEnded("run-open")).resolves.toBe(false);
    await expect(routedRunEnded("run-gone")).resolves.toBe(true);
    await expect(routedRunEnded("run-unreadable")).rejects.toThrow("the World is down");
    await expect(routedRunLive("run-open")).resolves.toBe(true);
    await expect(routedRunLive("run-gone")).resolves.toBe(false);
    await expect(routedRunLive("run-unreadable")).resolves.toBe(true);
  });

  it("reads a registered session from its store, and the durable host's once released", async () => {
    installProcessEngine(processEngine("durable"));
    const store = fixedStore([{ line: "Alice" }, { line: "Bob" }]);
    const release = registerSessionEventStore("session-alice", store);
    try {
      expect(sessionEventStore("session-alice")).toBe(store);
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
    const release = registerSessionEventStore("session-alice", fixedStore([]));
    try {
      expect(() => registerSessionEventStore("session-alice", fixedStore([]))).toThrow(
        'Session "session-alice" already has a session event store.',
      );
    } finally {
      release();
    }
  });
});
