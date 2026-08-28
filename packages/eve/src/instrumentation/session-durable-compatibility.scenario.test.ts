import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  assertDurableBoundaryCompatibility,
  type FrozenDurableBoundaryFixture,
} from "#internal/testing/durable-boundary-compatibility.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/preservation.js";
import {
  bindSessionInstrumentation,
  registerInstrumentationRuntime,
} from "#instrumentation/runtime.js";
import {
  readSerializedSessionInstrumentation,
  readSessionTraceId,
} from "#instrumentation/session-serialization.js";
import {
  OTEL_TRACE_ENABLED_KEY_NAME,
  SESSION_INSTRUMENTATION_DECISION_KEY_NAME,
  SESSION_INSTRUMENTATION_KEY_NAME,
  SESSION_TRACE_SEED_KEY_NAME,
} from "#instrumentation/session-types.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

const SESSION_ID = "legacy-session";
const TRACE_ID = "2".repeat(32);
const SPAN_ID = "1".repeat(16);
const execFileAsync = promisify(execFile);
const historicalProducer = fileURLToPath(
  new URL("../internal/testing/historical-session-instrumentation-producer.mjs", import.meta.url),
);

interface ExpectedInstrumentationMigration {
  readonly decision: InstrumentationDecision;
  readonly otelTraceEnabled?: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly sampled: boolean;
  readonly spanId?: string;
  readonly traceId?: string;
}

const fixtures: readonly FrozenDurableBoundaryFixture<ExpectedInstrumentationMigration>[] = [
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 1, "public"),
    expected: {
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      recordInputs: true,
      recordOutputs: true,
      sampled: true,
    },
    name: "sampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 0, "public"),
    expected: {
      decision: { action: "drop" },
      recordInputs: false,
      recordOutputs: false,
      sampled: false,
    },
    name: "unsampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "marker", 0, "public"),
    expected: {
      decision: { action: "drop" },
      otelTraceEnabled: false,
      recordInputs: false,
      recordOutputs: false,
      sampled: false,
      spanId: "b".repeat(16),
      traceId: "a".repeat(32),
    },
    name: "disabled OTel marker without a seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-45-0", "seed", 1, "private"),
    expected: {
      decision: { action: "record", recordInputs: false, recordOutputs: false },
      recordInputs: false,
      recordOutputs: false,
      sampled: true,
    },
    name: "private sampled session trace seed",
    source: "historical-eve-0-45-0",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-44-4", "agent", 1, "public"),
    expected: {
      decision: { action: "record", recordInputs: true, recordOutputs: true },
      recordInputs: true,
      recordOutputs: true,
      sampled: true,
    },
    name: "sampled agent trace before session seeds",
    source: "historical-eve-0-44-4",
  },
  {
    capture: () => captureHistoricalSession("historical-eve-0-44-4", "agent", 0, "public"),
    expected: {
      decision: { action: "drop" },
      recordInputs: false,
      recordOutputs: false,
      sampled: false,
    },
    name: "unsampled agent trace before session seeds",
    source: "historical-eve-0-44-4",
  },
];

class FixedIdGenerator extends AgentSpanIdGenerator {
  override allocateSpanId(): string {
    return "b".repeat(16);
  }

  override generateTraceId(): string {
    return "a".repeat(32);
  }
}

describe("legacy session instrumentation compatibility", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} from ${fixture.source}`, async () => {
      const tracePolicy = vi.fn(() => (fixture.expected.decision.action === "drop" ? true : false));
      registerInstrumentationRuntime({
        forceFlush: async () => undefined,
        hooks: createInstrumentationHooks([]),
        idGenerator: new FixedIdGenerator(),
        otelSettings: {
          recordInputs: true,
          recordOutputs: true,
          traceChannelRequests: false,
          tracePolicy,
        },
        prepareSessionTrace: async (event) => event.traceSeed!,
        runInContext: (_operation, execute) => execute(),
        shutdown: async () => undefined,
      });

      await assertDurableBoundaryCompatibility({
        assert: (result) => {
          expect(tracePolicy).not.toHaveBeenCalled();
          expect({
            migrated: result.first.serialized,
            rollback: result.rollbackSerialized,
            source: result.source,
          }).toMatchSnapshot(fixture.name);
          for (const pass of [result.first, result.repeated, result.rollback!]) {
            expect(pass.observation).toMatchObject({
              recordInputs: fixture.expected.recordInputs,
              recordOutputs: fixture.expected.recordOutputs,
            });
            const serialized = pass.serialized as Record<string, unknown>;
            const migrated = readSerializedSessionInstrumentation(serialized);
            const expectedSpanId = fixture.expected.spanId ?? SPAN_ID;
            const expectedTraceId = fixture.expected.traceId ?? TRACE_ID;
            expect(migrated).toMatchObject({
              decision: fixture.expected.decision,
              schemaVersion: 1,
              traceSeed: {
                spanId: expectedSpanId,
                traceFlags: fixture.expected.sampled ? 1 : 0,
                traceId: expectedTraceId,
              },
            });
            expect(serialized[SESSION_INSTRUMENTATION_DECISION_KEY_NAME]).toEqual(
              fixture.expected.decision,
            );
            expect(serialized[SESSION_TRACE_SEED_KEY_NAME]).toEqual(migrated?.traceSeed);
            expect(serialized[OTEL_TRACE_ENABLED_KEY_NAME]).toBe(
              fixture.expected.otelTraceEnabled ?? true,
            );
            expect(readSessionTraceId(serialized)).toBe(
              fixture.expected.sampled ? expectedTraceId : undefined,
            );
          }
        },
        boundary: "session instrumentation",
        fixture,
        hydrate: (serialized): Promise<ContextContainer> =>
          deserializeContext(serialized as Record<string, unknown>),
        migrate: (ctx: ContextContainer) => {
          const instrumentation = bindSessionInstrumentation({
            agentName: "weather",
            ctx,
            rootSessionId: SESSION_ID,
            sessionId: SESSION_ID,
          });
          return instrumentation?.telemetry();
        },
        rollback: {
          apply: (original, interrupted) =>
            preserveSerializedInstrumentationState(
              preserveSerializedAgentTraceState(original, interrupted),
              interrupted,
            ),
          preservedKeys: [
            SESSION_INSTRUMENTATION_KEY_NAME,
            SESSION_INSTRUMENTATION_DECISION_KEY_NAME,
            SESSION_TRACE_SEED_KEY_NAME,
            OTEL_TRACE_ENABLED_KEY_NAME,
            ...(fixture.source === "historical-eve-0-44-4" ? ["eve.harness.agentTrace"] : []),
          ],
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
