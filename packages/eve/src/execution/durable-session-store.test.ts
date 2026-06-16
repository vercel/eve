import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  createDurableSessionState,
  DURABLE_SESSION_VERSION,
  type DurableSessionSnapshot,
  type DurableSessionState,
  projectSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { projectToDurableSession } from "#execution/session.js";

const getRunMock = vi.hoisted(() => vi.fn());

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
}));

afterEach(() => {
  getRunMock.mockReset();
  vi.useRealTimers();
});

/**
 * Pins the cross-version wire contract: `version` discriminators,
 * spread-only forwarding (preserving unknown fields), and the closed
 * `NextDriverAction` dispatch surface. Breakage here means in-flight
 * sessions on a pinned older driver lose data on upgrade.
 */
describe("durable-session-store cross-version contract", () => {
  it("stamps `DurableSessionState.version` and never carries session-shape flags", () => {
    const session = buildSession({
      sessionId: "wrun_state_version",
      continuationToken: "http:test",
    });

    const state = projectSessionState({ session });

    expect(state.version).toBe(DURABLE_SESSION_VERSION);
    expect(state.sessionId).toBe("wrun_state_version");
    expect(state.continuationToken).toBe("http:test");
    expect(state.hasProxyInputRequests).toBe(false);
    // Emission state is projected onto the handle so framework steps
    // can stamp protocol events without taking an extra step boundary.
    expect(state.emissionState).toEqual({
      sequence: 0,
      sessionStarted: false,
      stepIndex: 0,
      turnId: "",
    });
    // Closed contract: pending-batch flags live on `NextDriverAction`
    // arms, not on the driver-visible state.
    expect(state).not.toHaveProperty("hasPendingInputBatch");
    expect(state).not.toHaveProperty("hasPendingRuntimeActionBatch");
    expect(state).not.toHaveProperty("pendingRuntimeActionKeys");
    expect(state).not.toHaveProperty("snapshot");
  });

  it("projects only the durable subset into DurableSession", () => {
    const session = buildSession({
      sessionId: "wrun_persist",
      continuationToken: "http:test",
      withRefreshableAgent: true,
    });

    const durable = projectToDurableSession(session);

    expect(durable.sessionId).toBe(session.sessionId);
    expect(durable.continuationToken).toBe(session.continuationToken);
    expect(durable.history).toBe(session.history);
    expect(durable.agent).toEqual({ system: session.agent.system });
    // turnAgent-derived fields are rebuilt every turn — not persisted.
    expect(durable.agent).not.toHaveProperty("modelReference");
    expect(durable.agent).not.toHaveProperty("tools");
    expect(durable.agent).not.toHaveProperty("compactionModelReference");
  });

  it("preserves unrecognized DurableSessionState fields via spread (forward compat)", () => {
    // Hypothetical state shape introduced by a newer eve version.
    const futureState: DurableSessionState & { futureFlag: { hint: string } } = {
      continuationToken: "http:test",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
      futureFlag: { hint: "experimental" },
      hasProxyInputRequests: false,
      sessionId: "wrun_future",
      version: 1,
    };

    // Mirror the driver's spread-only forwarding pattern.
    const passedThrough: DurableSessionState = { ...futureState };
    expect((passedThrough as { futureFlag?: unknown }).futureFlag).toEqual({
      hint: "experimental",
    });
  });

  it("preserves unrecognized fields on a DurableSessionSnapshot", () => {
    const durable = projectToDurableSession(
      buildSession({ sessionId: "wrun_snapshot", continuationToken: "http:test" }),
    );
    const snapshotWithFutureField = {
      session: { ...durable, futureField: { kind: "experimental" } },
      version: DURABLE_SESSION_VERSION,
    } as DurableSessionSnapshot;

    // Unknown fields inside the durable session shape must round-trip.
    const passedThrough = { ...snapshotWithFutureField };
    expect(passedThrough.version).toBe(DURABLE_SESSION_VERSION);
    expect((passedThrough.session as { futureField?: unknown }).futureField).toEqual({
      kind: "experimental",
    });
  });

  it("NextDriverAction `kind` is the closed driver dispatch surface", () => {
    const baseState: DurableSessionState = {
      continuationToken: "http:test",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
      hasProxyInputRequests: false,
      sessionId: "wrun_action",
      version: 1,
    };
    const ctx: Record<string, unknown> = { "eve.sessionId": "wrun_action" };

    const arms: NextDriverAction[] = [
      { kind: "done", output: "ok", serializedContext: ctx, sessionState: baseState },
      { kind: "park", serializedContext: ctx, sessionState: baseState },
      {
        kind: "dispatch-runtime-actions",
        pendingActionKeys: ["subagent-call:foo:call-1"],
        serializedContext: ctx,
        sessionState: baseState,
      },
    ];

    // Lock the closed-contract kind set. Adding a new arm is breaking.
    expect(new Set(arms.map((a) => a.kind))).toEqual(
      new Set(["done", "park", "dispatch-runtime-actions"]),
    );
  });

  it("creates state with the latest durable snapshot", () => {
    const session = buildSession({
      continuationToken: "http:test",
      sessionId: "wrun_embedded_write",
    });

    const state = createDurableSessionState({ session });

    expect(state).toEqual({
      ...projectSessionState({ session }),
      snapshot: {
        session: projectToDurableSession(session),
        version: DURABLE_SESSION_VERSION,
      },
    });
  });

  it("reads an embedded snapshot without opening the legacy stream", async () => {
    const session = buildSession({
      continuationToken: "http:test",
      sessionId: "wrun_embedded_read",
    });
    const state = createDurableSessionState({ session });

    const durableSession = await readDurableSession(state);

    expect(durableSession).toEqual(projectToDurableSession(session));
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("cancels the legacy tail read after loading one durable session snapshot", async () => {
    const session = buildSession({
      continuationToken: "http:test",
      sessionId: "wrun_tail_cancel",
    });
    const snapshot: DurableSessionSnapshot = {
      session: projectToDurableSession(session),
      version: DURABLE_SESSION_VERSION,
    };
    const cancel = vi.fn();
    const stream = new ReadableStream<DurableSessionSnapshot>({
      cancel,
      start(controller) {
        controller.enqueue(snapshot);
      },
    });
    const getReadable = vi.fn(() => stream);
    getRunMock.mockReturnValue({ getReadable });

    const durableSession = await readDurableSession(projectSessionState({ session }));

    expect(durableSession).toEqual(snapshot.session);
    expect(getRunMock).toHaveBeenCalledWith("wrun_tail_cancel");
    expect(getReadable).toHaveBeenCalledWith({
      namespace: "eve.session",
      startIndex: -1,
    });
    expect(cancel).toHaveBeenCalledWith("eve durable session tail read complete");
    expect(stream.locked).toBe(false);
  });

  it("throws a named timeout and cancels the legacy tail read when the stream hangs", async () => {
    vi.useFakeTimers();

    const session = buildSession({
      continuationToken: "http:test",
      sessionId: "wrun_tail_timeout",
    });
    const cancel = vi.fn();
    const stream = new ReadableStream<DurableSessionSnapshot>({
      cancel,
    });
    const getReadable = vi.fn(() => stream);
    getRunMock.mockReturnValue({ getReadable });

    const promise = readDurableSession(projectSessionState({ session }));
    const assertion = expect(promise).rejects.toMatchObject({
      message: expect.stringContaining(
        'Timed out reading durable session snapshot from stream "eve.session" for run wrun_tail_timeout after 10000ms.',
      ),
      name: "DurableSessionReadTimeoutError",
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;

    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(getReadable).toHaveBeenCalledTimes(1);
    expect(getReadable).toHaveBeenCalledWith({
      namespace: "eve.session",
      startIndex: -1,
    });
    expect(cancel).toHaveBeenCalledWith("eve durable session tail read timed out after 10000ms");
    expect(stream.locked).toBe(false);
  });
});

function buildSession(input: {
  sessionId: string;
  continuationToken: string;
  withRefreshableAgent?: boolean;
}): HarnessSession {
  return {
    agent: {
      compactionModelReference: input.withRefreshableAgent
        ? { id: "compaction-model", contextWindowTokens: 200_000 }
        : undefined,
      modelReference: { id: "test-model", contextWindowTokens: 200_000 },
      system: "test system",
      tools: input.withRefreshableAgent
        ? [{ description: "", inputSchema: { type: "object" }, name: "test" }]
        : [],
    },
    compaction: {
      lastKnownInputTokens: 100,
      lastKnownPromptMessageCount: 3,
      recentWindowSize: 10,
      threshold: 180_000,
    },
    continuationToken: input.continuationToken,
    history: [{ content: "hi", role: "user" }],
    sessionId: input.sessionId,
  };
}
