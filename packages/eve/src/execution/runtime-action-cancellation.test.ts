import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook } from "#compiled/@workflow/core/index.js";

import {
  runRuntimeActionCancellationScope,
  type RuntimeActionCancellationTarget,
} from "#execution/runtime-action-cancellation.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("runRuntimeActionCancellationScope", () => {
  // Cancellation can beat target discovery; the scope must wait for dispatch
  // and cancel every child that appeared during that race.
  it("cancels children started after cancellation arrives during dispatch", async () => {
    const cancellation = deferred<{ readonly kind: "cancel-turn" }>();
    const dispatch = deferred<DispatchResult>();
    const dispose = vi.fn();
    vi.mocked(createHook).mockReturnValue(
      Object.assign(cancellation.promise, { dispose, token: "cancel_1:runtime-actions" }) as never,
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue("complete");
    const running = runRuntimeActionCancellationScope({
      cancel,
      cancelToken: "cancel_1",
      dispatch: () => dispatch.promise,
      sessionId: "session_1",
      wait,
    });

    cancellation.resolve({ kind: "cancel-turn" });
    await Promise.resolve();
    await Promise.resolve();
    dispatch.resolve({ cancellationTargets: [TARGET] });

    await expect(running).resolves.toEqual({
      dispatchResult: { cancellationTargets: [TARGET] },
      result: "complete",
    });
    expect(cancel).toHaveBeenCalledWith([TARGET]);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

interface DispatchResult {
  readonly cancellationTargets: readonly RuntimeActionCancellationTarget[];
}

const TARGET: RuntimeActionCancellationTarget = {
  cancelToken: "child_cancel_1",
  kind: "local",
  nodeId: "child",
  sessionId: "child_session_1",
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
