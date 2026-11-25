import type { Durable, EngineApp } from "#execution/durable.js";
import { wakeAt } from "./wake-timer.js";
import { durableSessionEvents } from "#execution/durable-session-events.js";
import { hostEngine } from "#execution/hosts.js";
import type { SessionStepCall } from "#execution/session/steps.js";
import type { TurnStepInput } from "#execution/session/turn-step-types.js";
import { definePlatform } from "#platform/declaration.js";
import {
  sessionSteps,
  storeDurable,
  type StoreDurable,
  type StoreWakeOptions,
} from "#platform/engine.js";
import { registerCleanup } from "#runtime/lifetime.js";
import type { App } from "#runtime/app.js";
import { createUlid } from "#shared/ulid.js";

import { createMemorySessionStore } from "./session-host/memory-session-store.js";

export interface StorePlatformContext {
  readonly deploymentId: string;
  readonly sessionPrefix: string;
  readonly revision: {
    readonly deployedAt: string;
    readonly gitBranch: string;
    readonly gitSha: string;
  };
}

export default definePlatform<StorePlatformContext>({
  context: async () => ({
    deploymentId: "dpl_alice_store",
    sessionPrefix: "alice_",
    revision: {
      deployedAt: "2026-11-23T09:30:00.000Z",
      gitBranch: "alice/store-engine",
      gitSha: "a11ce5702e",
    },
  }),
  deployment: (_app, context) => ({
    environment: () => undefined,
    deploymentId: () => context.deploymentId,
    host: () => undefined,
    scope: () => undefined,
    revision: () => context.revision,
  }),
  durable: () => ({ start: startMemoryStoreEngine }),
});

function acrossBoundary({ sessionWritable, ...input }: TurnStepInput): TurnStepInput {
  return { ...structuredClone(input), sessionWritable };
}

function startMemoryStoreEngine(app: EngineApp, context: StorePlatformContext): Durable {
  const store = createMemorySessionStore();
  const hosting = hostEngine(app);
  const kept = new Map<string, unknown>();
  const known = new Set<string>();
  const running = new Set<string>();
  const woken = new Set<string>();
  const engineApp: App = {
    ...app,
    get durable(): Durable {
      return durable;
    },
  };

  const step: SessionStepCall = async (name, input, { key }) => {
    const sessionId = key.slice(0, key.indexOf(":"));
    const steps = sessionSteps(engineApp, {
      interrupts: engine.interrupts,
      streams: store.streams,
      content: store.content,
    });
    if (!kept.has(key)) {
      const stepInput = name === "turn" ? acrossBoundary(input as TurnStepInput) : input;
      let result: unknown;
      for (let attempt = 1; ; attempt += 1) {
        result = await steps.run(name, stepInput, { attempt, key, sessionId });
        if (typeof result !== "object" || result === null || !("yielded" in result)) break;
      }
      kept.set(key, structuredClone(result));
    }
    return (await steps.load(kept.get(key) as never, sessionId)) as never;
  };

  const run = async (sessionId: string): Promise<void> => {
    running.add(sessionId);
    try {
      await engine.run(sessionId, { deploymentId: context.deploymentId, step });
    } finally {
      running.delete(sessionId);
      if (woken.delete(sessionId)) void wake(sessionId);
    }
  };

  const wake = async (sessionId: string, options: StoreWakeOptions = {}): Promise<void> => {
    if (options.at !== undefined) {
      let cancel: (() => void) | undefined;
      registerCleanup(app.lifetime, () => cancel?.());
      cancel = wakeAt(options.at, () => void wake(sessionId));
      return;
    }
    if (!known.has(sessionId)) {
      known.add(sessionId);
      hosting.session(sessionId, durableSessionEvents(durable));
    }
    if (running.has(sessionId)) {
      woken.add(sessionId);
      return;
    }
    void run(sessionId).catch((error: unknown) => {
      console.error(`The memory store engine failed to run session "${sessionId}".`, error);
    });
  };

  const engine: StoreDurable = storeDurable({ store, wake });
  const durable: Durable = {
    ...engine.durable,
    start: (input) =>
      engine.durable.start({
        ...input,
        sessionId: input.sessionId ?? `${context.sessionPrefix}${createUlid()}`,
      }),
  };
  return durable;
}
