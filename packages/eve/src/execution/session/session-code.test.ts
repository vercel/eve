import { describe, expect, it } from "vitest";

import { opaque, type SessionStartInput } from "#execution/durable.js";
import { runSession, type RunSessionHost } from "#execution/session/run-session.js";
import { sealSessionRecord } from "#execution/session/record.js";
import { SessionCodeMismatchError, sessionCodeHash } from "#execution/session/session-code.js";
import { createMemorySessionStore } from "#internal/testing/session-host/memory-session-store.js";
import { storeDurable } from "#platform/engine.js";

const SESSION_ID = "session_alice";
const START: SessionStartInput & { readonly sessionId: string } = {
  sessionId: SESSION_ID,
  addresses: [],
  body: opaque({}),
};
const OTHER_CODE_RECORD = sealSessionRecord({
  generation: 1,
  open: undefined,
  transfer: {} as never,
  sessionCode: "b0b5e55",
});

function unusedHost(): RunSessionHost {
  const unused = (): never => {
    throw new Error("The run reached its host.");
  };
  return {
    adopted: unused,
    all: unused,
    deploymentId: "dpl_alice",
    inbox: {} as never,
    next: unused,
    now: unused,
    step: unused,
    stream: { tail: unused, append: unused, close: unused },
  };
}

describe("session code", () => {
  it("has no hash when eve runs from unstamped source", () => {
    expect(sessionCodeHash()).toBeUndefined();
  });

  it("rejects a record that another session code wrote before runSession() runs it", async () => {
    const error = await runSession(
      { sessionId: SESSION_ID, start: START, record: OTHER_CODE_RECORD },
      unusedHost(),
    ).catch((caught: unknown) => caught);

    expect(SessionCodeMismatchError.is(error)).toBe(true);
    expect(error).toMatchObject({
      message: `The record of session "${SESSION_ID}" is from session code "b0b5e55", and this deployment runs session code unstamped source. Park the session until a deployment with session code "b0b5e55" runs it, or retire the session.`,
      recordCode: "b0b5e55",
      runningCode: undefined,
      sessionId: SESSION_ID,
    });
  });

  it("leaves a store session parked with its record when storeDurable refuses to run it", async () => {
    const store = createMemorySessionStore();
    await store.begin(START);
    await store.saveRecord(SESSION_ID, OTHER_CODE_RECORD, 0);
    await store.setStatus(SESSION_ID, "parked");
    const engine = storeDurable({ store, wake: async () => {} });

    const error = await engine
      .run(SESSION_ID, { deploymentId: "dpl_alice", step: unusedHost().step })
      .catch((caught: unknown) => caught);

    expect(SessionCodeMismatchError.is(error)).toBe(true);
    expect(await store.status(SESSION_ID)).toBe("parked");
    expect((await store.loadRun(SESSION_ID))?.record).toBe(OTHER_CODE_RECORD);
  });
});
