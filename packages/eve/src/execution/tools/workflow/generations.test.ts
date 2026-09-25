import { describe, expect, it } from "vitest";

import {
  createGenerations,
  TaskEndedError,
  type GenerationCall,
  type GenerationEvent,
  type Generations,
} from "#execution/tools/workflow/generations.js";

const FIRST: GenerationCall = {
  callId: "call-start",
  input: { draft: "0.67" },
  stepIndex: 0,
  turn: { id: "turn-1", sequence: 0 },
};

function call(n: number): GenerationCall {
  return {
    callId: `call-${String(n)}`,
    input: { note: `send ${String(n)}` },
    stepIndex: 0,
    turn: { id: `turn-${String(n)}`, sequence: n - 1 },
  };
}

function drain(state: Generations, relayedReports = Infinity): GenerationEvent[] {
  const events: GenerationEvent[] = [];
  for (let event = state.next(relayedReports); event !== undefined;) {
    events.push(event);
    event = state.next(relayedReports);
  }
  return events;
}

function summary(events: readonly GenerationEvent[]): string[] {
  return events.map((event) =>
    event.kind === "started"
      ? `started g${String(event.generation)} send ${String(event.send)} (${event.call.callId})`
      : `reply g${String(event.generation)} ${event.result.status} read [${event.read.join(",")}]`,
  );
}

describe("createGenerations", () => {
  it("starts a generation for each send after a reply and drops a repeated send", async () => {
    const state = createGenerations(FIRST);
    state.reply("first draft");
    const received = state.receive();
    state.deliver(1, { note: "send 1" }, call(1));
    state.deliver(1, { note: "send 1" }, call(1));
    await expect(received).resolves.toEqual({ note: "send 1" });
    // The generation takes the context of the call that sent its input.
    expect(state.call.callId).toBe("call-1");
    state.reply("second draft");

    expect(summary(drain(state))).toEqual([
      "reply g1 completed read []",
      "started g2 send 1 (call-1)",
      "reply g2 completed read []",
    ]);
    expect(state.generation).toBe(2);
  });

  it("joins a send read before the reply to the current generation", async () => {
    const state = createGenerations(FIRST);
    state.deliver(1, { note: "shorter" }, call(1));
    await expect(state.receive()).resolves.toEqual({ note: "shorter" });
    state.reply("short draft");

    expect(summary(drain(state))).toEqual(["reply g1 completed read [1]"]);
    // The call that started the generation keeps its context.
    expect(state.call).toBe(FIRST);
  });

  it("allows one reply per generation", () => {
    const state = createGenerations(FIRST);
    state.reply("done");
    expect(() => state.reply("again")).toThrow("ctx.reply() was already called for generation 1");
  });

  it("shares one pending receive between concurrent readers", async () => {
    const state = createGenerations(FIRST);
    const first = state.receive();
    expect(state.receive()).toBe(first);
    state.deliver(1, { note: "one" }, call(1));
    await expect(first).resolves.toEqual({ note: "one" });
  });

  it("cancels the current generation and its queued sends, then gives the next a fresh signal", async () => {
    const state = createGenerations(FIRST);
    const firstSignal = state.signal;
    state.deliver(1, { note: "queued" }, call(1));
    state.cancel("Stopped by the model.");
    expect(firstSignal.aborted).toBe(true);
    // The body notices, stops, and waits for more input.
    const next = state.receive();
    state.deliver(2, { note: "after the cancel" }, call(2));
    await expect(next).resolves.toEqual({ note: "after the cancel" });
    expect(state.signal).not.toBe(firstSignal);
    expect(state.signal.aborted).toBe(false);

    expect(summary(drain(state))).toEqual([
      "reply g1 cancelled read []",
      "started g2 send 1 (call-1)",
      "reply g2 cancelled read []",
      "started g3 send 2 (call-2)",
    ]);
  });

  it("starts no generation from a read the body raced before a cancel and abandoned", async () => {
    const state = createGenerations(FIRST);
    // The body races a read against its work, and the work wins the race.
    const abandoned = state.receive();
    let taken = false;
    void abandoned.then(() => {
      taken = true;
    });
    state.cancel("Stopped by the model.");
    state.deliver(1, { note: "next" }, call(1));
    await Promise.resolve();
    expect(taken).toBe(false);
    // The cancelled work's late reply settles its own generation, not the send's.
    state.reply("stale");
    expect(summary(drain(state))).toEqual(["reply g1 cancelled read []"]);

    // A read after the cancel takes the send and starts its generation.
    const next = state.receive();
    await expect(next).resolves.toEqual({ note: "next" });
    state.reply("fresh");
    expect(summary(drain(state))).toEqual([
      "started g2 send 1 (call-1)",
      "reply g2 completed read []",
    ]);
  });

  it("confirms a cancel only from a read that follows it", async () => {
    const state = createGenerations(FIRST);
    const before = state.receive();
    state.cancel("Stopped by the model.");
    state.deliver(1, { note: "next" }, call(1));
    expect(drain(state)).toEqual([]);
    // The read after the cancel shares the pending read and settles the stopped generation.
    const after = state.receive();
    expect(after).toBe(before);
    await expect(after).resolves.toEqual({ note: "next" });
    expect(summary(drain(state))).toEqual([
      "reply g1 cancelled read []",
      "started g2 send 1 (call-1)",
    ]);
  });

  it("settles a cancelled generation cancelled even when the body replies", () => {
    const state = createGenerations(FIRST);
    state.cancel("Stopped by the model.");
    state.reply("finished anyway");
    expect(summary(drain(state))).toEqual(["reply g1 cancelled read []"]);
  });

  it("rejects a pending receive when the task ends and reports the unread sends", async () => {
    const state = createGenerations(FIRST);
    state.reply("done");
    state.deliver(1, { note: "one" }, call(1));
    await state.receive();
    state.deliver(2, { note: "two" }, call(2));
    state.deliver(3, { note: "three" }, call(3));
    state.end("Parent session ended");

    await expect(state.receive()).rejects.toBeInstanceOf(TaskEndedError);
    expect(state.signal.aborted).toBe(true);
    expect(state.finish({ output: "final", status: "completed" })).toEqual({ unread: [2, 3] });
  });

  it("ignores a value returned after a reply, which would be a second result", () => {
    const state = createGenerations(FIRST);
    state.reply("done");
    drain(state);

    expect(state.finish({ output: "late", status: "completed" })).toEqual({
      ignored: { output: "late", status: "completed" },
      unread: [],
    });
    expect(drain(state)).toEqual([]);
  });

  it("settles a generation that has not replied with the body's return value", () => {
    const state = createGenerations(FIRST);
    expect(state.finish({ output: "final", status: "completed" })).toEqual({ unread: [] });
    expect(summary(drain(state))).toEqual(["reply g1 completed read []"]);
  });

  it("holds a reply until the reports sent before it are relayed", () => {
    const state = createGenerations(FIRST);
    state.noteReport();
    state.reply("done");

    expect(state.next(0)).toBeUndefined();
    expect(state.next(1)).toMatchObject({ generation: 1, kind: "reply", reports: 1 });
  });
});
