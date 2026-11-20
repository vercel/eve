import type { InstrumentationProvider } from "#instrumentation/provider.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import type { PlatformContext } from "#platform/context.js";

export interface EveRuntimeInstrumentation {
  runtime: InstrumentationRuntime | undefined;
  readonly providers: Map<string, InstrumentationProvider>;
}

export interface EveRuntime {
  platform: PlatformContext | undefined;
  readonly instrumentation: EveRuntimeInstrumentation;
  onClose(close: () => Promise<void>): void;
  close(): Promise<void>;
}

export function createEveRuntime(): EveRuntime {
  const closers: Array<() => Promise<void>> = [];
  return {
    platform: undefined,
    instrumentation: { providers: new Map(), runtime: undefined },
    onClose(close) {
      closers.push(close);
    },
    async close() {
      for (const close of closers.splice(0).reverse()) await close();
    },
  };
}

const EVE_RUNTIME = Symbol.for("eve.runtime");

interface EveRuntimeHolder {
  [EVE_RUNTIME]?: EveRuntime;
}

const holder = globalThis as EveRuntimeHolder;

export function eveRuntime(): EveRuntime {
  return (holder[EVE_RUNTIME] ??= createEveRuntime());
}

export function installEveRuntime(runtime: EveRuntime): () => void {
  const previous = holder[EVE_RUNTIME];
  holder[EVE_RUNTIME] = runtime;
  return () => {
    holder[EVE_RUNTIME] = previous;
  };
}
