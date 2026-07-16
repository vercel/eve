import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { createSessionInputQueue } from "#execution/session-input-queue.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

describe("createSessionInputQueue", () => {
  afterEach(() => {
    createHookMock.mockReset();
  });

  it("preserves the ordering of remainders, returned input, and later queued input", async () => {
    const queue = createSessionInputQueue();
    queue.appendQueued(delivery("queued"));
    queue.returnSteering({ ...delivery("steering"), turnPolicy: "steer" });
    queue.prependReturned(delivery("returned"));
    queue.prependTurnRemainders([{ ...delivery("remainder"), turnPolicy: "steer" }]);

    const next = await queue.takeNextTurn();

    expect(next?.payloads.map((payload) => payload.message)).toEqual([
      "remainder",
      "returned",
      "queued",
      "steering",
    ]);
    expect(next?.turnPolicy).toBe("queue");
  });

  it("converts returned steering to queue policy in one place", async () => {
    const queue = createSessionInputQueue();
    queue.returnSteering({ ...delivery("steering"), turnPolicy: "steer" });

    await expect(queue.takeNextTurn()).resolves.toMatchObject({ turnPolicy: "queue" });
  });

  it("extracts only an explicitly addressed response from buffered input", async () => {
    const queue = createSessionInputQueue();
    const response: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "request-1", text: "approved" }] }],
    };
    queue.appendQueued(delivery("freeform"));
    queue.appendQueued(response);

    expect(queue.takeExplicitResponse()).toBe(response);
    await expect(queue.takeNextTurn()).resolves.toEqual(delivery("freeform"));
  });

  it("skips commands and preserves live delivery order", async () => {
    installHook([
      { command: "resolve", kind: "session-command" },
      delivery("first"),
      delivery("second"),
    ]);
    const queue = createSessionInputQueue();
    await queue.rekey("session-token");

    const first = await queue.takeNextTurn();
    const second = await queue.takeNextTurn();

    expect(first?.payloads.map((payload) => payload.message)).toEqual(["first"]);
    expect(second?.payloads.map((payload) => payload.message)).toEqual(["second"]);
    await queue.dispose();
  });

  it("normalizes live steering when no active turn can accept it", async () => {
    installHook([{ ...delivery("steering"), turnPolicy: "steer" }]);
    const queue = createSessionInputQueue();
    await queue.rekey("session-token");

    await expect(queue.takeNextTurn()).resolves.toMatchObject({ turnPolicy: "queue" });
    await queue.dispose();
  });
});

function delivery(message: string): DeliverHookPayload {
  return { kind: "deliver", payloads: [{ message }] };
}

function installHook(values: readonly HookPayload[]): void {
  const reads = [...values];
  createHookMock.mockReturnValue({
    token: "session-token",
    dispose: vi.fn(),
    getConflict: vi.fn(async () => null),
    [Symbol.asyncIterator]() {
      return {
        next: vi.fn(() => {
          const value = reads.shift();
          return value === undefined
            ? new Promise<IteratorResult<HookPayload>>(() => {})
            : Promise.resolve({ done: false, value });
        }),
      };
    },
  });
}
