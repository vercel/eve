import { describe, expect, it } from "vitest";
import {
  dehydrateStepArguments,
  hydrateStepArguments,
  dehydrateStepReturnValue,
  hydrateStepReturnValue,
} from "#compiled/@workflow/core/serialization.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import {
  applyTurnStepDelta,
  captureTurnStepState,
  createTurnStepDelta,
} from "./turn-step-delta.js";
import type { DurableStepDelta } from "./turn-step-delta.js";
import type { DurableStepResult, TurnStepState } from "./turn-step-types.js";

const runId = "wrun_delta_protocol_test";
async function encode(value: unknown): Promise<Uint8Array> {
  return (await dehydrateStepReturnValue(
    value,
    runId,
    undefined,
    [],
    globalThis,
    false,
    false,
    false,
  )) as Uint8Array;
}
async function decode(value: Uint8Array): Promise<DurableStepDelta> {
  return await hydrateStepReturnValue(value, runId, undefined);
}

function initial(): TurnStepState {
  return { serializedContext: { budget: { spent: 0 } }, sessionState: createTestSessionState() };
}

function append(state: TurnStepState, index: number): DurableStepResult {
  return {
    action: "continue",
    serializedContext: { budget: { spent: index + 1 } },
    sessionState: {
      ...state.sessionState,
      snapshot: {
        session: {
          ...state.sessionState.snapshot.session,
          history: [
            ...state.sessionState.snapshot.session.history,
            {
              role: "assistant",
              content: `message-${index}:` + "x".repeat(2048),
            },
          ],
        },
      },
    },
  };
}

describe("serialized turn deltas", () => {
  it("preserves rich values and aliases through the Workflow serializer", async () => {
    const before = initial();
    const shared = {
      at: new Date(1234),
      bytes: new Uint8Array([1, 2]),
      url: new URL("https://eve.dev/docs"),
    };
    const expected = {
      ...before,
      action: "continue" as const,
      serializedContext: { first: shared, second: shared },
    };
    const encoded = await encode(createTurnStepDelta(captureTurnStepState(before), expected));
    const result = applyTurnStepDelta(before, await decode(encoded));
    expect(result).toEqual(expected);
    expect(result.serializedContext.first).toBe(result.serializedContext.second);
  });

  it("rebuilds committed state from recorded outputs and retries from the recorded input", async () => {
    const start = initial();
    let current = start;
    let executions = 0;
    const outputs: Uint8Array[] = [];
    for (let index = 0; index < 8; index++) {
      const input = await dehydrateStepArguments(
        { args: [current], thisVal: undefined },
        runId,
        undefined,
      );
      const { args } = await hydrateStepArguments(input, runId, undefined);
      const attempt: TurnStepState = args[0];
      const captured = captureTurnStepState(attempt);
      executions++;
      if (index === 4) {
        // An interrupted attempt mutates only its hydrated input and never commits a delta.
        attempt.sessionState.snapshot.session.history.push({
          role: "user",
          kind: "user",
          content: "uncommitted",
        });
        const retried = await hydrateStepArguments(input, runId, undefined);
        executions++;
        outputs.push(
          await encode(
            createTurnStepDelta(
              captureTurnStepState(retried.args[0]),
              append(retried.args[0], index),
            ),
          ),
        );
      } else {
        outputs.push(await encode(createTurnStepDelta(captured, append(attempt, index))));
      }
      current = applyTurnStepDelta(current, await decode(outputs.at(-1)!));
    }
    let recovered = initial();
    for (const output of outputs) recovered = applyTurnStepDelta(recovered, await decode(output));
    expect(recovered).toEqual(current);
    expect(recovered.sessionState.snapshot.session.history).toHaveLength(8);
    expect(JSON.stringify(recovered)).not.toContain("uncommitted");
    expect(executions).toBe(9);
  });

  it("grows output bytes linearly while full inputs remain quadratic", async () => {
    const measurements: {
      steps: number;
      deltaBytes: number;
      snapshotBytes: number;
      inputBytes: number;
    }[] = [];
    for (const steps of [8, 16, 32]) {
      let state = initial();
      let deltaBytes = 0;
      let snapshotBytes = 0;
      let inputBytes = 0;
      for (let index = 0; index < steps; index++) {
        inputBytes += (
          (await dehydrateStepArguments(
            { args: [state] },
            runId,
            undefined,
            globalThis,
            false,
            false,
          )) as Uint8Array
        ).byteLength;
        const next = append(state, index);
        const delta = createTurnStepDelta(captureTurnStepState(state), next);
        expect(delta.delta.kind).not.toBe("replace");
        const wire = await encode(delta);
        const restored = await decode(wire);
        if (index > 0) expect(JSON.stringify(restored)).not.toContain(`message-${index - 1}:`);
        deltaBytes += wire.byteLength;
        snapshotBytes += (await encode(next)).byteLength;
        state = applyTurnStepDelta(state, restored);
        expect(state.sessionState).toEqual(next.sessionState);
      }
      measurements.push({ steps, deltaBytes, snapshotBytes, inputBytes });
    }
    for (let index = 1; index < measurements.length; index++) {
      expect(measurements[index]!.deltaBytes / measurements[index - 1]!.deltaBytes).toBeLessThan(
        2.1,
      );
      expect(measurements[index]!.inputBytes / measurements[index - 1]!.inputBytes).toBeGreaterThan(
        3,
      );
    }
    const last = measurements.at(-1)!;
    expect(
      (last.inputBytes + last.deltaBytes) / (last.inputBytes + last.snapshotBytes),
      JSON.stringify(measurements),
    ).toBeLessThan(0.55);
  });
});
