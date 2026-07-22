import { createWorkflowRuntime } from "#internal/loops/workflow/runtime.js";
import { readLoopKind } from "#internal/loops/config.js";
import type { LoopDriver } from "#internal/loops/contract.js";
import {
  loadInlineRuntimeModule,
  loadTemporalRuntimeModule,
} from "#internal/loops/local-runtime-loader.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";

const TEMPORAL_DRIVER_GLOBAL_KEY = Symbol.for("eve.loops.temporal-driver");

interface TemporalDriverCache {
  readonly driver: Promise<LoopDriver>;
  readonly sourceKey: string;
}

/** Selects one artifact-bound loop implementation at the Runtime construction boundary. */
export async function resolveLoopDriver(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<LoopDriver> {
  const kind = readLoopKind(input.environment);
  if (kind === "workflow") return createWorkflowDriver(input.compiledArtifactsSource);

  if (input.environment?.["VERCEL_ENV"] !== undefined || process.env.VERCEL_ENV !== undefined) {
    throw new Error(
      kind === "inline"
        ? 'EVE_LOOP="inline" cannot run in a Vercel Function because its session and event stores are process-local.'
        : 'EVE_LOOP="temporal" is local-only. A Vercel Function cannot host the required long-lived Temporal Worker.',
    );
  }

  if (kind === "inline") return await createInlineDriver(input.compiledArtifactsSource);
  return await getTemporalDriver(input.compiledArtifactsSource);
}

function createWorkflowDriver(compiledArtifactsSource: RuntimeCompiledArtifactsSource): LoopDriver {
  return {
    async close() {},
    createRuntime: (input) =>
      createWorkflowRuntime({ compiledArtifactsSource, nodeId: input?.nodeId }),
    kind: "workflow",
  };
}

async function createInlineDriver(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<LoopDriver> {
  const { createInlineLoopRuntime } = await loadInlineRuntimeModule();
  const driver: LoopDriver = {
    async close() {},
    createRuntime: (input) =>
      createInlineLoopRuntime({ compiledArtifactsSource, nodeId: input?.nodeId }),
    kind: "inline",
  };
  return driver;
}

async function getTemporalDriver(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<LoopDriver> {
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource);
  const existing = readTemporalDriverCache();
  if (existing !== null) {
    if (existing.sourceKey === sourceKey) return await existing.driver;
    Reflect.deleteProperty(globalThis, TEMPORAL_DRIVER_GLOBAL_KEY);
    void closeRetiredDriver(existing.driver);
  }

  const driver = createTemporalDriver(compiledArtifactsSource);
  Reflect.set(globalThis, TEMPORAL_DRIVER_GLOBAL_KEY, { driver, sourceKey });
  void driver.catch(() => {
    if (readTemporalDriverCache()?.driver === driver) {
      Reflect.deleteProperty(globalThis, TEMPORAL_DRIVER_GLOBAL_KEY);
    }
  });
  return await driver;
}

async function createTemporalDriver(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<LoopDriver> {
  const runtimeModule = await loadTemporalRuntimeModule();
  const { createTemporalLoopRuntime } = runtimeModule;
  const runtime = await createTemporalLoopRuntime({ compiledArtifactsSource });
  return {
    close: async () => await runtime.close(),
    createRuntime(input) {
      if (input?.nodeId !== undefined) {
        throw new Error("The Temporal loop implementation does not support delegated nodes.");
      }
      return runtime;
    },
    kind: "temporal",
  };
}

async function closeRetiredDriver(driver: Promise<LoopDriver>): Promise<void> {
  try {
    await (await driver).close();
  } catch {
    // A replacement driver does not depend on a retired driver's startup or cleanup.
  }
}

function readTemporalDriverCache(): TemporalDriverCache | null {
  const value: unknown = Reflect.get(globalThis, TEMPORAL_DRIVER_GLOBAL_KEY);
  if (!isRecord(value)) return null;
  if (typeof value["sourceKey"] !== "string" || !(value["driver"] instanceof Promise)) return null;
  return { driver: value["driver"] as Promise<LoopDriver>, sourceKey: value["sourceKey"] };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
