import { describe, expect, it } from "vitest";

import { dispatchSessionSteps, type SessionStepTable } from "#execution/session/steps.js";

interface Call {
  readonly name: string;
  readonly receiver: unknown;
  readonly args: readonly unknown[];
}

function recordingTable(calls: Call[]): SessionStepTable {
  return new Proxy({} as SessionStepTable, {
    get: (_table, name) =>
      function (this: unknown, ...args: unknown[]) {
        calls.push({ name: String(name), receiver: this, args });
        return Promise.resolve(undefined);
      },
  });
}

describe("dispatchSessionSteps", () => {
  it("calls each step function in call order before any microtask, with no receiver and only its input", () => {
    const calls: Call[] = [];
    const step = dispatchSessionSteps(recordingTable(calls));
    const alice = { caller: "alice" };
    const bob = { caller: "bob" };

    void step("resolveInitialTurnCaller", alice as never, {
      key: "session:0:resolveInitialTurnCaller",
    });
    void step("notifyTurnCaller", bob as never, { key: "session:1:notifyTurnCaller" });

    expect(calls).toEqual([
      { name: "resolveInitialTurnCaller", receiver: undefined, args: [alice] },
      { name: "notifyTurnCaller", receiver: undefined, args: [bob] },
    ]);
  });
});
