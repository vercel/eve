import type { Durable } from "#execution/durable.js";
import type { Hosts } from "#execution/hosts.js";
import type { InstrumentationProvider } from "#instrumentation/provider.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import type { Entities } from "#platform/entities.js";
import { createLifetime, type Lifetime } from "#runtime/lifetime.js";
import type { RuntimeSession } from "#runtime/sessions/runtime-session.js";

export interface App {
  readonly platform: Entities;
  readonly durable: Durable;
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
  started: App | undefined;
  platform: Entities | undefined;
  durable: Durable | undefined;
  defaultSession: RuntimeSession | undefined;
  readonly hosts: Hosts;
  readonly instrumentation: AppInstrumentation;
  readonly lifetime: Lifetime;
}

export function createProcessApp(): ProcessApp {
  return {
    bootedPhases: 0,
    started: undefined,
    platform: undefined,
    durable: undefined,
    defaultSession: undefined,
    hosts: { routes: new Set(), sessionEventStores: new Map() },
    instrumentation: { providers: new Map(), runtime: undefined, setup: undefined },
    lifetime: createLifetime(),
  };
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

export function installProcessApp(app: ProcessApp): () => void {
  const previous = holder[PROCESS_APP];
  holder[PROCESS_APP] = app;
  return () => {
    holder[PROCESS_APP] = previous;
  };
}
