import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { createSessionDeliveryHook } from "#execution/session-delivery-hook.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

describe("createSessionDeliveryHook", () => {
  beforeEach(() => {
    createHookMock.mockReset();
  });

  it("retains pending reads from both hooks across rekey", async () => {
    const oldRead = createDeferred<IteratorResult<HookPayload>>();
    const replacementRead = createDeferred<IteratorResult<HookPayload>>();
    const oldHook = createMockHook({ reads: [oldRead.promise], token: "old" });
    const replacementHook = createMockHook({
      reads: [replacementRead.promise],
      token: "replacement",
    });
    installHooks(oldHook, replacementHook);
    const deliveryHook = createSessionDeliveryHook([]);

    await deliveryHook.rekey("old");
    const pending = deliveryHook.next();
    await deliveryHook.rekey("replacement");

    oldRead.resolve(delivery("old"));
    await expect(pending).resolves.toEqual(delivery("old"));
    deliveryHook.consumeNext();

    replacementRead.resolve(delivery("replacement"));
    await expect(deliveryHook.next()).resolves.toEqual(delivery("replacement"));
    deliveryHook.consumeNext();
    await deliveryHook.dispose();

    expect(oldHook.dispose).toHaveBeenCalledOnce();
    expect(replacementHook.dispose).toHaveBeenCalledOnce();
  });

  it("appends drained rekey deliveries after existing buffered deliveries", async () => {
    const bufferedDeliveries = [deliveryPayload("existing")];
    const oldHook = createMockHook({
      reads: [Promise.resolve(delivery("old"))],
      token: "old",
    });
    const replacementHook = createMockHook({
      reads: [Promise.resolve(delivery("replacement"))],
      token: "replacement",
    });
    installHooks(oldHook, replacementHook);
    const deliveryHook = createSessionDeliveryHook(bufferedDeliveries);

    await deliveryHook.rekey("old");
    await deliveryHook.rekey("replacement");
    await deliveryHook.dispose();

    expect(bufferedDeliveries).toEqual([
      deliveryPayload("existing"),
      deliveryPayload("old"),
      deliveryPayload("replacement"),
    ]);
  });

  it("disposes a conflicting candidate without releasing the active hook", async () => {
    const oldHook = createMockHook({ token: "old" });
    const candidateHook = createMockHook({
      conflict: { runId: "wrun_owner" },
      token: "candidate",
    });
    installHooks(oldHook, candidateHook);
    const deliveryHook = createSessionDeliveryHook([]);

    await deliveryHook.rekey("old");
    await expect(deliveryHook.rekey("candidate")).rejects.toMatchObject({
      name: "HookConflictError",
      token: "candidate",
    });

    expect(candidateHook.dispose).toHaveBeenCalledOnce();
    expect(oldHook.dispose).not.toHaveBeenCalled();

    await deliveryHook.dispose();
    expect(oldHook.dispose).toHaveBeenCalledOnce();
  });

  it("preserves an old-hook disposal failure while cleaning the candidate", async () => {
    const failure = new Error("old hook disposal failed");
    const oldHook = createMockHook({
      dispose: vi.fn(async () => {
        throw failure;
      }),
      token: "old",
    });
    const candidateHook = createMockHook({ token: "candidate" });
    installHooks(oldHook, candidateHook);
    const deliveryHook = createSessionDeliveryHook([]);

    await deliveryHook.rekey("old");
    await expect(deliveryHook.rekey("candidate")).rejects.toBe(failure);

    expect(oldHook.dispose).toHaveBeenCalledOnce();
    expect(candidateHook.dispose).toHaveBeenCalledOnce();
  });

  it("drains a committed delivery once and tolerates the retired hook re-arm rejecting", async () => {
    // The old hook commits exactly one delivery before disposal (captured by
    // the armed iterator read). Re-arming the retired hook awaits the exhausted
    // cursor, which rejects; the delivery must surface exactly once and the
    // rejection must not throw or resurrect it across later drain cycles.
    const bufferedDeliveries: DeliverHookPayload[] = [];
    installHooks(
      createCursorHook({ committed: [deliveryPayload("old")], token: "old" }),
      createCursorHook({ committed: [], token: "replacement" }),
      createCursorHook({ committed: [], token: "third" }),
    );
    const deliveryHook = createSessionDeliveryHook(bufferedDeliveries);

    await deliveryHook.rekey("old");
    await deliveryHook.rekey("replacement");
    // A further rekey forces extra drain cycles that would surface a duplicate
    // if a retired re-arm re-yielded the already-consumed payload.
    await deliveryHook.rekey("third");
    await deliveryHook.dispose();

    expect(bufferedDeliveries).toEqual([deliveryPayload("old")]);
  });

  it("disposes without closing or settling a pending read", async () => {
    const hook = createMockHook({ token: "active" });
    installHooks(hook);
    const deliveryHook = createSessionDeliveryHook([]);

    await deliveryHook.rekey("active");
    void deliveryHook.next();
    await deliveryHook.dispose();

    expect(hook.dispose).toHaveBeenCalledOnce();
    expect(hook.return).not.toHaveBeenCalled();
  });
});

interface MockHook {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly hook: unknown;
  readonly return: ReturnType<typeof vi.fn>;
  readonly token: string;
}

function createMockHook(input: {
  readonly conflict?: { readonly runId: string } | null;
  readonly dispose?: ReturnType<typeof vi.fn>;
  readonly reads?: readonly Promise<IteratorResult<HookPayload>>[];
  readonly token: string;
}): MockHook {
  const reads = [...(input.reads ?? [])];
  const dispose = input.dispose ?? vi.fn();
  const getConflict = vi.fn(async () => input.conflict ?? null);
  const next = vi.fn(
    () =>
      reads.shift() ??
      new Promise<IteratorResult<HookPayload>>(() => {
        // Intentionally pending.
      }),
  );
  const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }) as const);
  const hook = Object.assign(new Promise<HookPayload>(() => {}), {
    [Symbol.asyncIterator]() {
      return { next, return: iteratorReturn };
    },
    dispose,
    getConflict,
    token: input.token,
  });
  return { dispose, hook, return: iteratorReturn, token: input.token };
}

/**
 * Builds a hook whose `await hook` and async iterator share one delivery
 * cursor: each read advances a queue of committed payloads, and awaiting an
 * exhausted cursor rejects with a `HookNotFoundError` — the contract the
 * retired-hook re-arm in `session-delivery-hook` relies on.
 */
function createCursorHook(input: {
  readonly committed: readonly HookPayload[];
  readonly token: string;
}): MockHook {
  const queue: IteratorResult<HookPayload>[] = input.committed.map((value) => ({
    done: false,
    value,
  }));
  const pull = (): IteratorResult<HookPayload> => queue.shift() ?? { done: true, value: undefined };
  const dispose = vi.fn();
  const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }) as const);
  const hook = {
    [Symbol.asyncIterator]() {
      return { next: vi.fn(async () => pull()), return: iteratorReturn };
    },
    dispose,
    getConflict: vi.fn(async () => null),
    // eslint-disable-next-line unicorn/no-thenable -- a Workflow Hook is itself a thenable
    then<T>(onFulfilled: (value: HookPayload) => T, onRejected?: (reason: unknown) => T) {
      const item = queue.shift();
      const settled =
        item === undefined
          ? Promise.reject(Object.assign(new Error("hook disposed"), { name: "HookNotFoundError" }))
          : Promise.resolve(item.value);
      return settled.then(onFulfilled, onRejected);
    },
    token: input.token,
  };
  return { dispose, hook, return: iteratorReturn, token: input.token };
}

function installHooks(...hooks: readonly MockHook[]): void {
  const queue = [...hooks];
  createHookMock.mockImplementation((options: { readonly token: string }) => {
    const hook = queue.shift();
    if (hook === undefined || hook.token !== options.token) {
      throw new Error(`Unexpected hook token "${options.token}".`);
    }
    return hook.hook;
  });
}

function delivery(message: string): IteratorResult<HookPayload> {
  return { done: false, value: deliveryPayload(message) };
}

function deliveryPayload(message: string): DeliverHookPayload {
  return { kind: "deliver", payloads: [{ message }] };
}

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
