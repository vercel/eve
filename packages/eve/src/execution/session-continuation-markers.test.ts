import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionContinuationMarkers } from "#execution/session-continuation-markers.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

describe("createSessionContinuationMarkers", () => {
  beforeEach(() => createHookMock.mockReset());

  it("derives marker tokens and disposes them on removal", async () => {
    const dispose = vi.fn();
    createHookMock.mockReturnValue({
      dispose,
      getConflict: vi.fn(async () => null),
      token: "slack:C1:T1:unsubscribed",
    });
    const state = createSessionContinuationMarkers();

    await state.apply({
      active: true,
      continuationToken: "slack:C1:T1",
      key: "unsubscribed",
      kind: "session-continuation-marker",
    });
    expect(createHookMock).toHaveBeenCalledWith({ token: "slack:C1:T1:unsubscribed" });

    await state.apply({
      active: false,
      continuationToken: "slack:C1:T1",
      key: "unsubscribed",
      kind: "session-continuation-marker",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes a candidate when claiming ownership throws", async () => {
    const failure = new Error("conflict lookup failed");
    const dispose = vi.fn();
    createHookMock.mockReturnValue({
      dispose,
      getConflict: vi.fn(async () => {
        throw failure;
      }),
      token: "slack:C1:T1:unsubscribed",
    });
    const state = createSessionContinuationMarkers();

    await expect(
      state.apply({
        active: true,
        continuationToken: "slack:C1:T1",
        key: "unsubscribed",
        kind: "session-continuation-marker",
      }),
    ).rejects.toBe(failure);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects and disposes every durable ownership conflict", async () => {
    const dispose = vi.fn();
    createHookMock.mockReturnValue({
      dispose,
      getConflict: vi.fn(async () => ({ runId: "session-1" })),
      token: "slack:C1:T1:unsubscribed",
    });
    const state = createSessionContinuationMarkers();

    await expect(
      state.apply({
        active: true,
        continuationToken: "slack:C1:T1",
        key: "unsubscribed",
        kind: "session-continuation-marker",
      }),
    ).rejects.toMatchObject({ name: "HookConflictError" });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes active markers when the session ends", async () => {
    const dispose = vi.fn();
    createHookMock.mockReturnValue({
      dispose,
      getConflict: vi.fn(async () => null),
      token: "slack:C1:T1:unsubscribed",
    });
    const state = createSessionContinuationMarkers();
    await state.apply({
      active: true,
      continuationToken: "slack:C1:T1",
      key: "unsubscribed",
      kind: "session-continuation-marker",
    });

    await state.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects keys that can escape the continuation namespace", async () => {
    const state = createSessionContinuationMarkers();

    await expect(
      state.apply({
        active: true,
        continuationToken: "slack:C1:T1",
        key: "other:token",
        kind: "session-continuation-marker",
      }),
    ).rejects.toThrow(/cannot contain colons/);
    expect(createHookMock).not.toHaveBeenCalled();
  });
});
