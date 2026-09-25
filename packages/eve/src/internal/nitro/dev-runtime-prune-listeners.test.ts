import { expect, it, vi } from "vitest";

import {
  notifyDevelopmentRuntimePruned,
  onDevelopmentRuntimePruned,
} from "#internal/nitro/dev-runtime-prune-listeners.js";

it("scopes notifications to an app and unregisters only the closing world", async () => {
  const first = vi.fn(async () => undefined);
  const second = vi.fn(async () => undefined);
  const other = vi.fn(async () => undefined);
  const unsubscribeFirst = onDevelopmentRuntimePruned("/app", first);
  const unsubscribeSecond = onDevelopmentRuntimePruned("/app/.", second);
  const unsubscribeOther = onDevelopmentRuntimePruned("/other", other);
  try {
    await notifyDevelopmentRuntimePruned("/app");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    unsubscribeFirst();
    await notifyDevelopmentRuntimePruned("/app");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeOther();
  }
  await notifyDevelopmentRuntimePruned("/app");
  expect(second).toHaveBeenCalledTimes(2);
});

it("propagates reconciliation errors to the pruning caller", async () => {
  const error = new Error("storage unavailable");
  const unsubscribe = onDevelopmentRuntimePruned("/app", async () => {
    throw error;
  });
  try {
    await expect(notifyDevelopmentRuntimePruned("/app")).rejects.toBe(error);
  } finally {
    unsubscribe();
  }
});
