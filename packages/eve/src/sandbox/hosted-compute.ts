import { appOf } from "#context/app.js";
import { contextScopeValue, contextStorage, withContextScopeValue } from "#context/container.js";
import type { Compute } from "#platform/entities.js";
import { processPlatformNow } from "#platform/process.js";

const BUILD_COMPUTE = Symbol.for("eve.build-compute");

interface BuildCompute {
  readonly compute: Compute | undefined;
}

export function withBuildCompute<T>(compute: Compute | undefined, fn: () => T): T {
  return withContextScopeValue(BUILD_COMPUTE, { compute } satisfies BuildCompute, fn);
}

export function hostedCompute(): Compute | undefined {
  const app = appOf(contextStorage.getStore());
  if (app !== undefined) return app.platform.compute;
  return (contextScopeValue<BuildCompute>(BUILD_COMPUTE) ?? processPlatformNow()).compute;
}
