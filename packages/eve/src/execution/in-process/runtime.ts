import type { Runtime } from "#channel/types.js";
import type { Durable } from "#execution/durable.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { createInProcessHost, type InProcessHost, type InProcessHostOptions } from "./host.js";
import type { WorkflowFunction } from "./runs.js";

export type InProcessRuntimeOptions = InProcessHostOptions;

export interface InProcessRuntime extends Runtime {
  readonly durable: Durable;
  settled(sessionId: string): Promise<void>;
  holds(token: string): boolean;
  stepsRunning(sessionId: string): number;
  idle(): Promise<void>;
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
  ): Promise<{ readonly sessionId: string }>;
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  dispose(): Promise<void>;
}

export function createInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions,
): InProcessRuntime {
  const runtimes = new Map<string, InProcessRuntime>();
  const runtimeFor = (child: SessionRuntimeConfig): InProcessRuntime => {
    const key = JSON.stringify(child);
    let runtime = runtimes.get(key);
    if (runtime === undefined) runtimes.set(key, (runtime = runtimeOn(host, child)));
    return runtime;
  };
  const host = createInProcessHost(options, runtimeFor);
  return runtimeFor(config);
}

function runtimeOn(host: InProcessHost, config: SessionRuntimeConfig): InProcessRuntime {
  const { inboxes, running } = host;
  return {
    ...sessionRuntime(host.durable, host.hosts, config),
    durable: host.durable,
    async startEntry(entry) {
      const started = await host.startEntry(entry);
      if (started.kind === "held") throw new Error("The session's address is held elsewhere.");
      return { sessionId: started.sessionId };
    },
    async settled(sessionId) {
      await running.get(sessionId);
    },
    holds: (token) => inboxes.holder(token) !== undefined,
    stepsRunning: (sessionId) => host.stepsRunning(sessionId),
    idle: () => host.idle(),
    registerWorkflow: (workflowId, workflowBody) =>
      host.runs.registerWorkflow(workflowId, workflowBody),
    dispose: () => host.dispose(),
  };
}
