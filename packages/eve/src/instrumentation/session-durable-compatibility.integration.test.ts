import { afterEach, describe, expect, it, vi } from "vitest";

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

interface ExpectedInstrumentationMigration {
  readonly decision: InstrumentationDecision;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly sampled: boolean;
}

const fixtures: readonly FrozenDurableBoundaryFixture<ExpectedInstrumentationMigration>[] = [
  {
    capture: () => captureEve045Session(1),
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
    capture: () => captureEve045Session(0),
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
    capture: () => captureEve044AgentTrace(1),
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
    capture: () => captureEve044AgentTrace(0),
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

      const result = await assertDurableBoundaryCompatibility({
        boundary: "session instrumentation",
        fixture,
        hydrate: (serialized) => deserializeContext(serialized as Record<string, unknown>),
        migrate: (ctx) => {
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
          ],
        },
        serialize: serializeContext,
      });

      expect(result.source).toMatchSnapshot(fixture.name);
      expect(tracePolicy).not.toHaveBeenCalled();
      for (const pass of [result.first, result.repeated, result.rollback!]) {
        expect(pass.observation).toMatchObject({
          recordInputs: fixture.expected.recordInputs,
          recordOutputs: fixture.expected.recordOutputs,
        });
        const serialized = pass.serialized as Record<string, unknown>;
        const migrated = readSerializedSessionInstrumentation(serialized);
        expect(migrated).toMatchObject({
          decision: fixture.expected.decision,
          schemaVersion: 1,
          traceSeed: {
            spanId: SPAN_ID,
            traceFlags: fixture.expected.sampled ? 1 : 0,
            traceId: TRACE_ID,
          },
        });
        expect(serialized[SESSION_INSTRUMENTATION_DECISION_KEY_NAME]).toEqual(
          fixture.expected.decision,
        );
        expect(serialized[SESSION_TRACE_SEED_KEY_NAME]).toEqual(migrated?.traceSeed);
        expect(serialized[OTEL_TRACE_ENABLED_KEY_NAME]).toBe(true);
        expect(readSessionTraceId(serialized)).toBe(
          fixture.expected.sampled ? TRACE_ID : undefined,
        );
      }
    });
  }
});

async function captureEve045Session(traceFlags: number): Promise<unknown> {
  const historical = await loadHistoricalRuntime("historical-eve-0-45-0");
  const ctx = new historical.ContextContainer();
  ctx.set(historical.keys.ChannelInstrumentationKey, {
    channelType: "http",
    kind: "channel:http",
    metadata: { audience: "public" },
  });
  ctx.set(historical.keys.OtelTraceEnabledKey, true);
  ctx.set(historical.keys.SessionTraceSeedKey, {
    spanId: SPAN_ID,
    traceFlags,
    traceId: TRACE_ID,
  });
  return historical.serializeContext(ctx);
}

async function captureEve044AgentTrace(traceFlags: number): Promise<unknown> {
  const historical = await loadHistoricalRuntime("historical-eve-0-44-4");
  const storeModule = (await import(
    new URL("./tracing/agent-trace-context-store.js", historical.packageEntry).href
  )) as {
    readonly ContextAgentTraceStateStore: new () => {
      setSession(sessionId: string, state: Record<string, unknown>): void;
    };
  };
  const ctx = new historical.ContextContainer();
  ctx.set(historical.keys.ChannelInstrumentationKey, {
    channelType: "http",
    kind: "channel:http",
    metadata: { audience: "public" },
  });
  historical.contextStorage.run(ctx, () => {
    new storeModule.ContextAgentTraceStateStore().setSession(SESSION_ID, {
      agentName: "weather",
      channelAudience: "public",
      channelKind: "http",
      context: { isRemote: false, spanId: SPAN_ID, traceFlags, traceId: TRACE_ID },
      rootSessionId: SESSION_ID,
      turnsInWindow: 7,
      window: 0,
    });
  });
  return historical.serializeContext(ctx);
}

async function loadHistoricalRuntime(packageName: string): Promise<{
  readonly ContextContainer: new () => { set(key: unknown, value: unknown): void };
  readonly contextStorage: { run<T>(ctx: unknown, callback: () => T): T };
  readonly keys: Record<string, unknown>;
  readonly packageEntry: string;
  readonly serializeContext: (ctx: unknown) => Record<string, unknown>;
}> {
  const packageEntry = import.meta.resolve(packageName);
  const [container, keys, serialization] = await Promise.all([
    import(new URL("./context/container.js", packageEntry).href),
    import(new URL("./context/keys.js", packageEntry).href),
    import(new URL("./context/serialize.js", packageEntry).href),
  ]);
  return {
    ContextContainer: container.ContextContainer as new () => {
      set(key: unknown, value: unknown): void;
    },
    contextStorage: container.contextStorage as {
      run<T>(ctx: unknown, callback: () => T): T;
    },
    keys: keys as Record<string, unknown>,
    packageEntry,
    serializeContext: serialization.serializeContext as (ctx: unknown) => Record<string, unknown>,
  };
}
