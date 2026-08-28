import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  isWorkflowOtelTraceEnabled,
  readSessionTraceId,
} from "#execution/eve-workflow-attributes.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import {
  bindSessionInstrumentation,
  registerInstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import {
  assertDurableBoundaryCompatibility,
  type DurableBoundaryFixture,
} from "#internal/testing/durable-boundary-compatibility.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";

const SESSION_ID = "legacy-session";
const TRACE_ID = "2".repeat(32);
const execFileAsync = promisify(execFile);
const historicalProducer = fileURLToPath(
  new URL("../internal/testing/historical-session-instrumentation-producer.mjs", import.meta.url),
);

interface ExpectedSessionBehavior {
  readonly agentTraceFlags?: number;
  readonly otelTraceEnabled?: boolean;
  readonly policyCallsPerPass: number;
  readonly policyDecision: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly traceId?: string;
}

const fixtures: readonly DurableBoundaryFixture<ExpectedSessionBehavior>[] = [
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 1, "public"),
    expected: {
      otelTraceEnabled: true,
      policyCallsPerPass: 0,
      policyDecision: false,
      recordInputs: true,
      recordOutputs: true,
      traceId: TRACE_ID,
    },
    name: "sampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 0, "public"),
    expected: {
      otelTraceEnabled: true,
      policyCallsPerPass: 0,
      policyDecision: true,
      recordInputs: false,
      recordOutputs: false,
    },
    name: "unsampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "marker", 0, "public"),
    expected: {
      otelTraceEnabled: false,
      policyCallsPerPass: 1,
      policyDecision: true,
      recordInputs: true,
      recordOutputs: true,
    },
    name: "disabled OTel marker without a seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 1, "private"),
    expected: {
      otelTraceEnabled: true,
      policyCallsPerPass: 0,
      policyDecision: false,
      recordInputs: false,
      recordOutputs: false,
      traceId: TRACE_ID,
    },
    name: "private sampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-44-4", "agent", 1, "public"),
    expected: {
      agentTraceFlags: 1,
      policyCallsPerPass: 1,
      policyDecision: false,
      recordInputs: false,
      recordOutputs: false,
    },
    name: "sampled agent trace before session seeds",
    source: "historical-eve-0-44-4",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-44-4", "agent", 0, "public"),
    expected: {
      agentTraceFlags: 0,
      policyCallsPerPass: 1,
      policyDecision: true,
      recordInputs: true,
      recordOutputs: true,
    },
    name: "unsampled agent trace before session seeds",
    source: "historical-eve-0-44-4",
  },
];

describe("historical session instrumentation compatibility", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} from ${fixture.source}`, async () => {
      const tracePolicy = vi.fn(() => fixture.expected.policyDecision);
      registerInstrumentationRuntime({
        forceFlush: async () => undefined,
        hooks: createInstrumentationHooks([]),
        otelSettings: {
          recordInputs: true,
          recordOutputs: true,
          traceChannelRequests: false,
          tracePolicy,
        },
        runInContext: (_operation, execute) => execute(),
        shutdown: async () => undefined,
      });

      await assertDurableBoundaryCompatibility({
        assert: (result) => {
          expect(tracePolicy).toHaveBeenCalledTimes(fixture.expected.policyCallsPerPass * 3);
          expect({ exercised: result.first.serialized, source: result.source }).toMatchSnapshot(
            fixture.name,
          );
          for (const pass of [result.first, result.repeated, result.rollback!]) {
            expect(pass.observation).toEqual({
              recordInputs: fixture.expected.recordInputs,
              recordOutputs: fixture.expected.recordOutputs,
            });
            const serialized = pass.serialized as Record<string, unknown>;
            if (fixture.expected.agentTraceFlags !== undefined) {
              expect(serialized["eve.harness.agentTrace"]).toEqual({
                actions: {},
                sessions: {
                  [SESSION_ID]: {
                    agentName: "weather",
                    channelAudience: "public",
                    channelKind: "http",
                    context: {
                      isRemote: false,
                      spanId: "1".repeat(16),
                      traceFlags: fixture.expected.agentTraceFlags,
                      traceId: TRACE_ID,
                    },
                    rootSessionId: SESSION_ID,
                  },
                },
                turns: {},
              });
            } else {
              expect(pass.serialized).toEqual(result.source);
            }
            expect(isWorkflowOtelTraceEnabled(serialized)).toBe(
              fixture.expected.otelTraceEnabled === true,
            );
            expect(readSessionTraceId(serialized)).toBe(fixture.expected.traceId);
            expect(serialized["eve.sessionInstrumentation"]).toBeUndefined();
            expect(serialized["eve.sessionInstrumentationDecision"]).toBeUndefined();
          }
        },
        boundary: "session instrumentation",
        exercise: async (ctx: ContextContainer) => {
          const instrumentation = bindSessionInstrumentation({
            agentName: "weather",
            ctx,
            rootSessionId: SESSION_ID,
            sessionId: SESSION_ID,
          });
          return instrumentation?.runStep(
            {
              environment: "test",
              eveVersion: "historical-compatibility",
              hasInput: false,
              session: { sessionId: SESSION_ID },
            },
            async () => {
              const telemetry = instrumentation.telemetry();
              return {
                recordInputs: telemetry?.recordInputs,
                recordOutputs: telemetry?.recordOutputs,
              };
            },
          );
        },
        fixture,
        hydrate: (serialized): Promise<ContextContainer> =>
          deserializeContext(serialized as Record<string, unknown>),
        rollback: {
          apply: (original, interrupted) =>
            preserveSerializedInstrumentationState(
              preserveSerializedAgentTraceState(original, interrupted),
              interrupted,
            ),
          preservedKeys:
            fixture.source === "historical-eve-0-44-4" ? ["eve.harness.agentTrace"] : [],
        },
        serialize: serializeContext,
      });
    });
  }
});

async function captureHistoricalSession(
  packageName: string,
  shape: "agent" | "marker" | "seed",
  traceFlags: number,
  audience: "private" | "public",
): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [
    historicalProducer,
    packageName,
    shape,
    String(traceFlags),
    audience,
  ]);
  return JSON.parse(stdout) as unknown;
}
