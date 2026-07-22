import { describe, expect, it } from "vitest";

import { TemporalLoopAddressStore } from "./address-store.js";

describe("TemporalLoopAddressStore", () => {
  it("rekeys one active session atomically and removes the prior token", () => {
    const store = new TemporalLoopAddressStore();
    store.begin({
      continuationToken: "initial-token",
      sessionId: "session-1",
      workflowId: "workflow-1",
    });
    store.attachRun({ runId: "run-1", sessionId: "session-1" });

    store.rekey({ continuationToken: "anchored-token", sessionId: "session-1" });

    expect(store.resolve("initial-token")).toBeNull();
    expect(store.resolve("anchored-token")).toEqual({
      continuationToken: "anchored-token",
      runId: "run-1",
      sessionId: "session-1",
      workflowId: "workflow-1",
    });
  });

  it("preserves a rekey that wins the race with client run attachment", () => {
    const store = new TemporalLoopAddressStore();
    store.begin({
      continuationToken: "initial-token",
      sessionId: "session-1",
      workflowId: "workflow-1",
    });

    store.rekey({ continuationToken: "anchored-token", sessionId: "session-1" });
    store.attachRun({ runId: "run-1", sessionId: "session-1" });

    expect(store.resolve("initial-token")).toBeNull();
    expect(store.resolve("anchored-token")?.runId).toBe("run-1");
  });

  it("rejects a token already owned by another active session", () => {
    const store = new TemporalLoopAddressStore();
    store.begin({
      continuationToken: "token-1",
      sessionId: "session-1",
      workflowId: "workflow-1",
    });
    store.attachRun({ runId: "run-1", sessionId: "session-1" });
    store.begin({
      continuationToken: "token-2",
      sessionId: "session-2",
      workflowId: "workflow-2",
    });
    store.attachRun({ runId: "run-2", sessionId: "session-2" });

    expect(() => store.rekey({ continuationToken: "token-1", sessionId: "session-2" })).toThrow(
      'Continuation token "token-1" is already owned by session "session-1".',
    );
    expect(store.resolve("token-2")?.sessionId).toBe("session-2");
  });

  it("settles idempotently and makes the token undeliverable", () => {
    const store = new TemporalLoopAddressStore();
    store.begin({
      continuationToken: "token-1",
      sessionId: "session-1",
      workflowId: "workflow-1",
    });
    store.attachRun({ runId: "run-1", sessionId: "session-1" });

    expect(store.settle("session-1")).toBe(true);
    expect(store.settle("session-1")).toBe(false);
    expect(store.resolve("token-1")).toBeNull();
  });
});
