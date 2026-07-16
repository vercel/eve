import { afterEach, describe, expect, it, vi } from "vitest";

import { createTurnHookInbox } from "#execution/turn-hook-inbox.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

describe("createTurnHookInbox", () => {
  afterEach(() => {
    createHookMock.mockReset();
  });

  it("creates the iterator before claiming ownership", async () => {
    const order: string[] = [];
    createHookMock.mockReturnValue({
      token: "turn:signal",
      dispose: vi.fn(),
      getConflict: vi.fn(async () => {
        order.push("claim");
        return null;
      }),
      [Symbol.asyncIterator]() {
        order.push("iterator");
        return { next: vi.fn(() => new Promise(() => {})) };
      },
    });

    await createTurnHookInbox({ conflict: "throw", token: "turn:signal" });

    expect(order).toEqual(["iterator", "claim"]);
  });

  it("returns undefined for a tolerated ownership conflict", async () => {
    const dispose = vi.fn();
    createHookMock.mockReturnValue({
      token: "session:cancel",
      dispose,
      getConflict: vi.fn(async () => ({ runId: "stale-run" })),
      [Symbol.asyncIterator]() {
        return { next: vi.fn(() => new Promise(() => {})) };
      },
    });

    await expect(
      createTurnHookInbox({ conflict: "return-undefined", token: "session:cancel" }),
    ).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("throws an ownership conflict when the token must be unique", async () => {
    createHookMock.mockReturnValue({
      token: "turn:steer",
      dispose: vi.fn(),
      getConflict: vi.fn(async () => ({ runId: "owner" })),
      [Symbol.asyncIterator]() {
        return { next: vi.fn(() => new Promise(() => {})) };
      },
    });

    await expect(
      createTurnHookInbox({ conflict: "throw", token: "turn:steer" }),
    ).rejects.toMatchObject({ name: "HookConflictError" });
  });

  it("shares one pending durable read and rearms after it resolves", async () => {
    const next = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: "first" })
      .mockResolvedValueOnce({ done: false, value: "second" });
    createHookMock.mockReturnValue({
      token: "turn:signal",
      dispose: vi.fn(),
      getConflict: vi.fn(async () => null),
      [Symbol.asyncIterator]() {
        return { next };
      },
    });
    const inbox = await createTurnHookInbox<string>({
      conflict: "throw",
      token: "turn:signal",
    });

    const first = inbox.next();
    expect(inbox.next()).toBe(first);
    await expect(first).resolves.toBe("first");
    await expect(inbox.next()).resolves.toBe("second");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("disposes idempotently without closing the iterator", async () => {
    const dispose = vi.fn();
    const close = vi.fn();
    createHookMock.mockReturnValue({
      token: "turn:signal",
      dispose,
      getConflict: vi.fn(async () => null),
      [Symbol.asyncIterator]() {
        return { next: vi.fn(() => new Promise(() => {})), return: close };
      },
    });
    const inbox = await createTurnHookInbox({ conflict: "throw", token: "turn:signal" });

    await inbox.dispose();
    await inbox.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
