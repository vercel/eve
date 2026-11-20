import type { PlatformContext } from "#platform/context.js";

export interface EveRuntime {
  readonly platform: PlatformContext;
  onClose(close: () => Promise<void>): void;
  close(): Promise<void>;
}

export function createEveRuntime(input: { readonly platform: PlatformContext }): EveRuntime {
  const closers: Array<() => Promise<void>> = [];
  return {
    platform: input.platform,
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

export function installEveRuntime(runtime: EveRuntime): () => void {
  const previous = holder[EVE_RUNTIME];
  holder[EVE_RUNTIME] = runtime;
  return () => {
    holder[EVE_RUNTIME] = previous;
  };
}

export function eveRuntime(): EveRuntime | undefined {
  return holder[EVE_RUNTIME];
}
