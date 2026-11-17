import type { AnyEventRequest } from "@workflow/world";
import { vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { forgetSessionLive } from "#definitions/state.js";
import { forgetRunnableOwnerRun } from "#execution/session-inbox/runnable-owner.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-references.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { currentTestWorld, type StoredWait } from "#internal/testing/workflow-test-world.js";
import { cancelRun } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

export type HostName = "workflow" | "in-process";

export interface HostCapabilities {
  readonly retries: boolean;
  readonly durable: boolean;
  readonly moves: boolean;
  readonly externalCancel: boolean;
  readonly stamps: boolean;
}

export interface CompletingStep {
  readonly name: string;
  readonly runId: string;
}

export interface StepFaultPlan {
  loseCompletion?(step: CompletingStep): boolean;
  readonly failFirstWrites?: number;
}

export interface HostSetup {
  readonly workflows?: readonly WorkflowBody[];
  readonly faults?: StepFaultPlan;
  readonly specVersion?: string;
}

export interface HostUnderTest {
  readonly name: HostName;
  readonly runtime: Runtime;
  readonly capabilities: HostCapabilities;
  settled(): Promise<void>;
  failedWrites(): number;
  workflowRunsStarted(): Promise<number>;
  restart?(options?: { readonly beforeStart?: () => Promise<void> }): Promise<void>;
  cancelRunOutsideEve?(sessionId: string): Promise<void>;
  storedWaits?(): Promise<StoredWait[]>;
  runStatus?(runId: string): Promise<string>;
  runSpecVersion?(runId: string): Promise<number | undefined>;
  rewriteRunAttributes?(runId: string, patch: Record<string, string | undefined>): Promise<void>;
  dispose(): Promise<void>;
}

export interface SessionHostKind {
  readonly capabilities: HostCapabilities;
  readonly dispatchStep?: string;
  make(setup?: HostSetup): Promise<HostUnderTest>;
}

const IN_PROCESS_CALLBACK_BASE_URL = "http://session-host.in-process";

const IN_PROCESS_CAPABILITIES: HostCapabilities = {
  externalCancel: false,
  durable: false,
  moves: false,
  retries: true,
  stamps: false,
};

const WORKFLOW_CAPABILITIES: HostCapabilities = {
  externalCancel: true,
  durable: true,
  moves: true,
  retries: true,
  stamps: true,
};

export const inProcessHost: SessionHostKind = {
  capabilities: IN_PROCESS_CAPABILITIES,
  make: makeInProcessHost,
};

export const workflowHost: SessionHostKind = {
  capabilities: WORKFLOW_CAPABILITIES,
  dispatchStep: "publishDispatchedCallsStep",
  make: makeWorkflowHost,
};

async function makeInProcessHost(setup: HostSetup = {}): Promise<HostUnderTest> {
  const failed = { writes: 0 };
  const runtime = createTestInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    {
      callbackBaseUrl: IN_PROCESS_CALLBACK_BASE_URL,
      ...(setup.faults !== undefined && { stepFaults: inProcessFaults(setup.faults, failed) }),
    },
  );
  let started = 0;
  for (const { body, workflowId } of setup.workflows ?? []) {
    runtime.registerWorkflow(workflowId, (...args: never[]) => {
      started += 1;
      return (body as (...args: never[]) => unknown)(...args);
    });
  }
  return {
    name: "in-process",
    runtime,
    capabilities: IN_PROCESS_CAPABILITIES,
    settled: () => runtime.idle(),
    failedWrites: () => failed.writes,
    workflowRunsStarted: async () => started,
    dispose: () => runtime.dispose(),
  };
}

async function makeWorkflowHost(setup: HostSetup = {}): Promise<HostUnderTest> {
  const testWorld = currentTestWorld();
  const failed = { writes: 0 };
  const faults =
    setup.faults === undefined ? undefined : workflowFaults(testWorld, setup.faults, failed);
  const restart = async (options?: { readonly beforeStart?: () => Promise<void> }) => {
    const recovered = await testWorld.restart(options);
    for (const runId of recovered) {
      forgetSessionLive(runId);
      forgetRunnableOwnerRun(runId);
    }
  };
  if (setup.specVersion !== undefined) {
    vi.stubEnv("WORKFLOW_SPEC_VERSION", setup.specVersion);
    await restart();
  }
  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  return {
    name: "workflow",
    runtime,
    capabilities: WORKFLOW_CAPABILITIES,
    settled: () => testWorld.idle(),
    failedWrites: () => failed.writes,
    async workflowRunsStarted() {
      const runs = await testWorld.world.runs.list({
        pagination: { limit: 100 },
        resolveData: "none",
        workflowName: workflowToolRunWorkflowReference.workflowId,
      });
      return runs.data.length;
    },
    async restart(options) {
      faults?.restore();
      await restart(options);
    },
    async cancelRunOutsideEve(sessionId) {
      await cancelRun(testWorld.world, sessionId);
    },
    storedWaits: () => testWorld.storedWaits(),
    runStatus: async (runId) =>
      (await testWorld.world.runs.get(runId, { resolveData: "none" })).status,
    runSpecVersion: async (runId) =>
      (await testWorld.world.runs.get(runId, { resolveData: "none" })).specVersion,
    rewriteRunAttributes: (runId, patch) => testWorld.rewriteRunAttributes(runId, patch),
    async dispose() {
      faults?.restore();
      await testWorld.idle();
      for (const runId of await testWorld.activeRunIds()) {
        await cancelRun(testWorld.world, runId).catch(() => {});
      }
      await testWorld.idle();
      if (setup.specVersion !== undefined) {
        vi.unstubAllEnvs();
        await restart();
      }
    },
  };
}

function inProcessFaults(plan: StepFaultPlan, failed: { writes: number }): StepFaults {
  let failingWrites = plan.failFirstWrites ?? 0;
  const written = new WeakSet<object>();
  return {
    loseCompletion: (step) =>
      plan.loseCompletion?.({ name: step.name, runId: step.sessionId }) === true,
    failWrite(step) {
      const first = !written.has(step);
      written.add(step);
      if (!first || failingWrites === 0) return false;
      failingWrites -= 1;
      failed.writes += 1;
      return true;
    },
  };
}

function workflowFaults(
  testWorld: ReturnType<typeof currentTestWorld>,
  plan: StepFaultPlan,
  failed: { writes: number },
) {
  const { world } = testWorld;
  const createBatch = world.events.createBatch;
  world.events.createBatch = undefined;
  const create = world.events.create.bind(world.events);
  let failingWrites = plan.failFirstWrites ?? 0;
  let failNextWrite = false;
  const getWriter = WritableStream.prototype.getWriter;
  const writerSpy = vi.spyOn(WritableStream.prototype, "getWriter").mockImplementation(function (
    this: WritableStream<Uint8Array>,
  ) {
    const writer = getWriter.call(this);
    const write = writer.write.bind(writer);
    writer.write = async (chunk) => {
      if (failNextWrite) {
        failNextWrite = false;
        failed.writes += 1;
        throw new Error("The session stream is unavailable");
      }
      return await write(chunk);
    };
    return writer;
  });
  const eventSpy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
    const [runId, event] = args as [string, AnyEventRequest];
    const stepName =
      event.eventType === "step_started" || event.eventType === "step_completed"
        ? String((event.eventData as { stepName?: string }).stepName)
        : undefined;
    if (event.eventType === "step_started" && stepName?.includes("turnStep") && failingWrites > 0) {
      failingWrites -= 1;
      failNextWrite = true;
    }
    if (
      event.eventType === "step_completed" &&
      stepName !== undefined &&
      plan.loseCompletion?.({ name: stepName, runId }) === true
    ) {
      forgetSessionLive(runId);
      testWorld.redeliverNextFailure();
      throw new Error("Process exited after publication, before checkpoint");
    }
    return await create(...args);
  });
  return {
    restore() {
      eventSpy.mockRestore();
      writerSpy.mockRestore();
      world.events.createBatch = createBatch;
    },
  };
}
