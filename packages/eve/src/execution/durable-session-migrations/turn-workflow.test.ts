import { describe, expect, it } from "vitest";

import type { HookPayload } from "#channel/types.js";
import {
  DURABLE_SESSION_VERSION,
  type DurableSessionState,
} from "#execution/durable-session-store.js";

import {
  createTurnWorkflowInput,
  migrateTurnWorkflowInput,
  TURN_WORKFLOW_INPUT_VERSION,
  type TurnWorkflowInput,
} from "./turn-workflow.js";

describe("turn workflow wire migrations", () => {
  it("returns a current workflow input unchanged", () => {
    const input = {
      capabilities: undefined,
      completionToken: "turn-token",
      driverCapabilities: { turnInbox: true },
      mode: "conversation",
      stepInput: {
        input: createDelivery(),
        parentWritable: new WritableStream<Uint8Array>(),
        serializedContext: { state: "current" },
        sessionState: createSessionState(),
      },
      version: TURN_WORKFLOW_INPUT_VERSION,
    } satisfies TurnWorkflowInput;

    expect(migrateTurnWorkflowInput(input)).toBe(input);
  });

  it("creates versioned workflow input for new turn workflow starts", () => {
    const delivery = createDelivery();
    const parentWritable = new WritableStream<Uint8Array>();
    const sessionState = createSessionState();

    expect(
      createTurnWorkflowInput({
        capabilities: undefined,
        completionToken: "turn-token",
        delivery,
        mode: "conversation",
        parentWritable,
        serializedContext: { state: "driver" },
        sessionState,
      }),
    ).toEqual({
      capabilities: undefined,
      completionToken: "turn-token",
      driverCapabilities: { cancelledTurnSettle: true, turnInbox: true },
      mode: "conversation",
      stepInput: {
        input: delivery,
        parentWritable,
        serializedContext: { state: "driver" },
        sessionState,
      },
      version: TURN_WORKFLOW_INPUT_VERSION,
    });
  });

  it("migrates pre-version (unversioned) workflow input into the current shape", () => {
    const delivery = createDelivery();
    const parentWritable = new WritableStream<Uint8Array>();
    const sessionState = createSessionState({
      continuationToken: "http:pre-version",
      sessionId: "wrun_pre_version",
    });

    expect(
      migrateTurnWorkflowInput({
        capabilities: undefined,
        completionToken: "turn-token",
        delivery,
        mode: "conversation",
        parentWritable,
        serializedContext: { state: "pre-version" },
        sessionState,
      }),
    ).toEqual({
      capabilities: undefined,
      completionToken: "turn-token",
      mode: "conversation",
      stepInput: {
        input: delivery,
        parentWritable,
        serializedContext: { state: "pre-version" },
        sessionState,
      },
      version: TURN_WORKFLOW_INPUT_VERSION,
    });
  });

  it("ignores legacy fields dropped from older flat shapes (e.g. sessionWritable)", () => {
    const delivery = createDelivery();
    const sessionState = createSessionState();

    const migrated = migrateTurnWorkflowInput({
      capabilities: undefined,
      completionToken: "turn-token",
      delivery,
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { state: "legacy" },
      sessionState,
      sessionWritable: new WritableStream(),
    });

    expect(migrated.version).toBe(TURN_WORKFLOW_INPUT_VERSION);
    expect("sessionWritable" in migrated).toBe(false);
    expect("sessionWritable" in migrated.stepInput).toBe(false);
    expect(migrated.stepInput.input).toBe(delivery);
  });

  it("throws clearly on workflow input from a newer version", () => {
    expect(() => migrateTurnWorkflowInput({ version: 999 })).toThrow(
      /turn workflow input: encountered version 999/,
    );
  });

  it("rejects a versionless value that is not the pre-version shape", () => {
    expect(() =>
      migrateTurnWorkflowInput({
        capabilities: undefined,
        completionToken: "turn-token",
        mode: "conversation",
        stepInput: {
          input: createDelivery(),
          parentWritable: new WritableStream<Uint8Array>(),
          serializedContext: { state: "missing-version" },
          sessionState: createSessionState(),
        },
      }),
    ).toThrow(/turn workflow input: version 0 value is not a recognized pre-version shape/);
  });

  it("throws clearly on workflow input from malformed version", () => {
    expect(() =>
      migrateTurnWorkflowInput({
        capabilities: undefined,
        completionToken: "turn-token",
        mode: "conversation",
        stepInput: {
          input: createDelivery(),
          parentWritable: new WritableStream<Uint8Array>(),
          serializedContext: { state: "malformed-version" },
          sessionState: createSessionState(),
        },
        version: "1",
      }),
    ).toThrow(/turn workflow input: value has no numeric "version" field/);
  });
});

function createDelivery(): HookPayload {
  return { kind: "deliver", payloads: [{ message: "hello" }] };
}

function createSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test",
    version: DURABLE_SESSION_VERSION,
    ...overrides,
  };
}
