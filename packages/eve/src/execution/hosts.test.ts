import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelRoutedRun,
  createProcessHosts,
  hostEngine,
  installProcessEngine,
  installedDurable,
  installedProcessEngine,
  registerHostedRoute,
  registerSessionEventStore,
  resumeRoutedHook,
  resumeRoutedSessionInbox,
  routedRunEnded,
  routedRunLive,
  sessionEventStore,
  sessionSignInCallbacks,
  stepAttempt,
  type HostedRoute,
  type ProcessEngine,
  type ProcessHosts,
  type ResumeAddress,
} from "#execution/hosts.js";
import { decodeDeliveryAddress } from "#execution/durable.js";
import {
  readSessionRecordHistory,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { createLifetime, endLifetime } from "#runtime/lifetime.js";
import { HookNotFoundError } from "#shared/run-errors.js";

function fixedStore(records: readonly unknown[]): SessionEventStore {
  const encoder = new TextEncoder();
  return {
    assertFollowable: async () => {},
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
      start: async () => ({ kind: "held" }),
      deliver: async () => ({ accepted: true }),
      sessionFor: async () => undefined,
      readStream: async function* () {},
      tail: async () => -1,
      status: async () => undefined,
    },
    resume: async (to) => {
      const address = decodeDeliveryAddress(to);
      if (address.kind === "hook") durable.reached.push(`resume ${address.token}`);
      else if (address.kind === "session")
        durable.reached.push(
          `inbox ${typeof address.address === "string" ? address.address : address.address.sessionId}`,
        );
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
  let hosts: ProcessHosts;
  beforeEach(() => {
    hosts = createProcessHosts();
    durable.reached = [];
    durable.attempt = undefined;
    durable.callbackBaseUrl = undefined;
  });

  it("without a durable host, an id no route holds is gone and no step is a retry", async () => {
    await expect(resumeRoutedHook(hosts, "hook-alice", {})).rejects.toThrow(HookNotFoundError);
    await expect(routedRunLive(hosts, "run-bob")).resolves.toBe(false);
    await expect(routedRunEnded(hosts, "run-bob")).resolves.toBe(true);
    expect(stepAttempt(hosts)).toBeUndefined();
    expect(installedDurable(hosts)).toBeUndefined();
    expect(() => sessionEventStore(hosts, "session-alice")).toThrow(
      'No host in this realm holds session "session-alice".',
    );
  });

  it("keeps the first durable engine, and refuses a different one", () => {
    const first = processEngine("durable");
    installProcessEngine(hosts, first);
    expect(installProcessEngine(hosts, processEngine("durable"))).toBe(first);
    expect(() => installProcessEngine(hosts, processEngine("other"))).toThrow(
      `This realm's durable engine is "durable"; "other" can't replace it.`,
    );
    expect(installedProcessEngine(hosts)).toBe(first);
    expect(installedDurable(hosts)).toBe(first.durable);
  });

  it("reads the attempt of the step running now from the durable host", () => {
    installProcessEngine(hosts, processEngine("durable"));
    durable.attempt = 1;
    expect(stepAttempt(hosts)).toBe(1);
    durable.attempt = 2;
    expect(stepAttempt(hosts)).toBe(2);
    durable.attempt = undefined;
    expect(stepAttempt(hosts)).toBeUndefined();
  });

  it("asks the route running a session how it's called back, and the durable host for others", () => {
    installProcessEngine(hosts, processEngine("durable"));
    const deliver: ResumeAddress = async () => {};
    const release = registerHostedRoute(hosts, {
      deliver: async () => undefined,
      runEnded: () => undefined,
      cancelRun: () => undefined,
      signInCallbacks: (sessionId) =>
        sessionId === "session-alice"
          ? { callbackBaseUrl: "http://alice.example", deliver }
          : undefined,
    });
    try {
      expect(sessionSignInCallbacks(hosts, "session-alice")).toEqual({
        callbackBaseUrl: "http://alice.example",
        deliver,
      });
      expect(sessionSignInCallbacks(hosts, "session-bob")).toBeUndefined();
      durable.callbackBaseUrl = "https://bob.example";
      expect(sessionSignInCallbacks(hosts, "session-bob")?.callbackBaseUrl).toBe(
        "https://bob.example",
      );
    } finally {
      durable.callbackBaseUrl = undefined;
      release();
    }
  });

  it("asks the routes first, and the durable host for what no route holds", async () => {
    installProcessEngine(hosts, processEngine("durable"));
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
    const release = registerHostedRoute(hosts, route);
    try {
      await resumeRoutedHook(hosts, "hook-held", {});
      await expect(resumeRoutedHook(hosts, "hook-gone", {})).rejects.toThrow(HookNotFoundError);
      await expect(routedRunEnded(hosts, "run-held")).resolves.toBe(true);
      await expect(routedRunLive(hosts, "run-held")).resolves.toBe(false);
      await expect(cancelRoutedRun(hosts, "run-held", "stop")).resolves.toBe(true);
      await expect(cancelRoutedRun(hosts, "run-held-ended", "stop")).resolves.toBe(false);
      await resumeRoutedSessionInbox(hosts, { sessionId: "session-alice" }, delivery);
      expect(delivered).toEqual(["hook-held", "inbox session-alice"]);
      expect(durable.reached).toEqual([]);

      await resumeRoutedHook(hosts, "hook-durable", {});
      await expect(cancelRoutedRun(hosts, "run-durable", "stop")).resolves.toBe(true);
      await resumeRoutedSessionInbox(hosts, { sessionId: "session-bob" }, delivery);
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
    installProcessEngine(hosts, processEngine("durable"));
    await expect(routedRunEnded(hosts, "run-done")).resolves.toBe(true);
    await expect(routedRunEnded(hosts, "run-open")).resolves.toBe(false);
    await expect(routedRunEnded(hosts, "run-gone")).resolves.toBe(true);
    await expect(routedRunEnded(hosts, "run-unreadable")).rejects.toThrow("the World is down");
    await expect(routedRunLive(hosts, "run-open")).resolves.toBe(true);
    await expect(routedRunLive(hosts, "run-gone")).resolves.toBe(false);
    await expect(routedRunLive(hosts, "run-unreadable")).resolves.toBe(true);
  });

  it("reads a registered session from its store, and the durable host's once released", async () => {
    installProcessEngine(hosts, processEngine("durable"));
    const store = fixedStore([{ line: "Alice" }, { line: "Bob" }]);
    const release = registerSessionEventStore(hosts, "session-alice", store);
    try {
      expect(sessionEventStore(hosts, "session-alice")).toBe(store);
      await expect(readSessionStreamTailIndex(hosts, "session-alice")).resolves.toBe(1);
      await expect(readAll(readSessionRecordHistory(hosts, "session-alice", -1))).resolves.toEqual([
        { line: "Bob" },
      ]);
    } finally {
      release();
    }
    await expect(readAll(readSessionRecordHistory(hosts, "session-alice", 0))).resolves.toEqual([
      { line: "kept by the durable host" },
    ]);
  });

  it("refuses a second store for the same session", () => {
    const release = registerSessionEventStore(hosts, "session-alice", fixedStore([]));
    try {
      expect(() => registerSessionEventStore(hosts, "session-alice", fixedStore([]))).toThrow(
        'Session "session-alice" already has a session event store.',
      );
    } finally {
      release();
    }
  });

  it("keeps what an engine hosts until the app's lifetime ends", async () => {
    const lifetime = createLifetime();
    const engine = hostEngine({ hosts, lifetime });
    const reached: string[] = [];
    engine.route({
      deliver: async (token) => {
        reached.push(token);
        return "delivered";
      },
      runEnded: () => undefined,
      cancelRun: () => undefined,
    });
    const store = fixedStore([{ type: "session.started" }]);
    engine.session("session-alice", store);

    await resumeRoutedHook(hosts, "hook-alice", {});
    expect(reached).toEqual(["hook-alice"]);
    expect(sessionEventStore(hosts, "session-alice")).toBe(store);

    await endLifetime(lifetime);
    await expect(resumeRoutedHook(hosts, "hook-alice", {})).rejects.toThrow(HookNotFoundError);
    expect(() => sessionEventStore(hosts, "session-alice")).toThrow(
      'No host in this realm holds session "session-alice".',
    );
  });
});
