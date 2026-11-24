import type { Durable } from "#execution/durable.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { InstrumentationProvider } from "#instrumentation/provider.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import type { PlatformDeclaration } from "#platform/declaration.js";
import type { Entities } from "#platform/entities.js";
import {
  createProcessHosts,
  stepAttempt,
  type AppHosts,
  type ProcessHosts,
} from "#execution/hosts.js";
import { createLifetime, type Lifetime } from "#runtime/lifetime.js";
import type { RuntimeSession } from "#runtime/sessions/runtime-session.js";

/** A booted eve application. */
export interface App {
  /** The entities that eve made from the platform declaration. */
  readonly platform: Entities;
  /** The started durable engine. */
  readonly durable: Durable;
  /** The routes and streams that engines registered. Register them with `hostEngine()`. */
  readonly hosts: AppHosts;
  /** The lifetime of the app. */
  readonly lifetime: Lifetime;
}

export interface Session {
  readonly id: string;
  readonly lifetime: Lifetime;
}

export interface AppInstrumentation {
  runtime: InstrumentationRuntime | undefined;
  setup: Promise<void> | undefined;
  readonly providers: Map<string, InstrumentationProvider>;
}

export interface ProcessApp {
  bootedPhases: number;
  booting: Promise<void>;
  started: App | undefined;
  declaration: PlatformDeclaration<unknown> | undefined;
  context: unknown;
  platform: Entities | undefined;
  durable: Durable | undefined;
  defaultSession: RuntimeSession | undefined;
  artifacts: (() => RuntimeCompiledArtifactsSource) | undefined;
  readonly hosts: ProcessHosts;
  readonly instrumentation: AppInstrumentation;
  readonly lifetime: Lifetime;
}

export function createProcessApp(): ProcessApp {
  return {
    bootedPhases: 0,
    booting: Promise.resolve(),
    started: undefined,
    declaration: undefined,
    context: undefined,
    platform: undefined,
    durable: undefined,
    defaultSession: undefined,
    artifacts: undefined,
    hosts: createProcessHosts(),
    instrumentation: { providers: new Map(), runtime: undefined, setup: undefined },
    lifetime: createLifetime(),
  };
}

export function processArtifacts(): (() => RuntimeCompiledArtifactsSource) | undefined {
  return processApp().artifacts;
}

export function openSession(app: App, id: string): Session {
  return { id, lifetime: createLifetime(app.lifetime) };
}

const PROCESS_APP = Symbol.for("eve.app");

interface ProcessAppHolder {
  [PROCESS_APP]?: ProcessApp;
}

const holder = globalThis as ProcessAppHolder;

export function processApp(): ProcessApp {
  return (holder[PROCESS_APP] ??= createProcessApp());
}

export function startedApp(): App {
  const { started } = processApp();
  if (started === undefined) {
    throw new Error(
      "A Workflow step ran in a process that has not started its eve app. The step bundle must load the generated boot modules, which start the app before any step runs.",
    );
  }
  return started;
}

export function stepApp(): App | undefined {
  const { started, hosts } = processApp();
  if (started === undefined) return undefined;
  return stepAttempt(hosts) === undefined ? undefined : started;
}

export function builtInHosts(): ProcessHosts {
  return processApp().hosts;
}

export function installProcessApp(app: ProcessApp): () => void {
  const previous = holder[PROCESS_APP];
  holder[PROCESS_APP] = app;
  return () => {
    holder[PROCESS_APP] = previous;
  };
}
