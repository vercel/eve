import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  emitStreamContent,
  getHarnessEmissionState,
  type HarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessEmitFn, HarnessSession } from "#harness/types.js";

async function* streamOf(parts: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> {
  for (const part of parts) {
    yield part;
  }
}

const EMISSION_STATE: HarnessEmissionState = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

function createEmitStub(): HarnessEmitFn {
  return vi.fn(async () => {});
}

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "test",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test",
    history: [],
    sessionId: "sess-test",
    state,
  };
}

describe("getHarnessEmissionState", () => {
  it("returns defaults when no state exists", () => {
    expect(getHarnessEmissionState(createSession().state)).toEqual({
      sessionStarted: false,
      sequence: 0,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("returns defaults when state key is missing", () => {
    expect(getHarnessEmissionState(createSession({ other: "value" }).state)).toEqual({
      sessionStarted: false,
      sequence: 0,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("reads persisted emission state", () => {
    const session = createSession({
      "eve.harness.emission": {
        sessionStarted: true,
        sequence: 3,
        stepIndex: 1,
        turnId: "turn_3",
      },
    });

    expect(getHarnessEmissionState(session.state)).toEqual({
      sessionStarted: true,
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_3",
    });
  });
});

describe("setHarnessEmissionState", () => {
  it("writes emission state to the session", () => {
    const session = createSession();
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    };

    const updated = setHarnessEmissionState(session, state);

    expect(getHarnessEmissionState(updated.state)).toEqual(state);
  });

  it("preserves existing session state keys", () => {
    const session = createSession({ "other.key": "preserved" });
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    };

    const updated = setHarnessEmissionState(session, state);

    expect(updated.state?.["other.key"]).toBe("preserved");
    expect(getHarnessEmissionState(updated.state)).toEqual(state);
  });

  it("round-trips through get after set", () => {
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 5,
      stepIndex: 2,
      turnId: "turn_5",
    };

    const session = setHarnessEmissionState(createSession(), state);
    const retrieved = getHarnessEmissionState(session.state);

    expect(retrieved).toEqual(state);
  });
});

describe("emitStreamContent error-part handling", () => {
  it("preserves the original Error instance when the stream emits one", async () => {
    const original = new TypeError("upstream rejected");

    await expect(
      emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: original, type: "error" } as TextStreamPart<ToolSet>]),
      ),
    ).rejects.toBe(original);
  });

  it("surfaces the .message field of an Error-shaped plain-object throwable", async () => {
    // Structured-clone across a workflow step strips the prototype but
    // keeps the fields — the harness must not collapse this to
    // `new Error("[object Object]")`.
    const raw = { message: "upstream 503", name: "APICallError", statusCode: 503 };

    let caught: unknown;
    try {
      await emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: raw, type: "error" } as TextStreamPart<ToolSet>]),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream 503");
    expect((caught as Error).name).toBe("APICallError");
  });

  it("falls back to a JSON-ish message for opaque plain-object throwables", async () => {
    // Regression guard for the user-facing
    // `"I hit an error while handling your request ([object Object])"`
    // bug caused by `new Error(String(partError))`.
    const raw = { code: "E_GATEWAY", status: 500 };

    let caught: unknown;
    try {
      await emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: raw, type: "error" } as TextStreamPart<ToolSet>]),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toBe("[object Object]");
    expect((caught as Error).message).toBe('{"code":"E_GATEWAY","status":500}');
  });
});
