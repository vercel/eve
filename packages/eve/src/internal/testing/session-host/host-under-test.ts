import type { AnyEventRequest } from "@workflow/world";
import { vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { forgetSessionLive } from "#definitions/state.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import type { StepFaults } from "#execution/in-process/step-attempts.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-references.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { currentTestWorld, type StoredWait } from "#internal/testing/workflow-test-world.js";
import { cancelRun } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { WorkflowBody } from "#tools/workflow-body.js";

// A session host as the host battery (`battery.ts`) drives it: its runtime, what it can do, when
// it rests, and the faults a test injects into it. Workflow runs on the test file's local World;
// the in-process host runs in memory. A host without a capability skips the cases that need it.

export type HostName = "workflow" | "in-process";

export interface HostCapabilities {
  /** A step that loses its completion or throws runs again, up to a limit (`HostSetup.faults`). */
  readonly retries: boolean;
  /** Sessions outlive the process that runs them (`restart`). */
  readonly durable: boolean;
  /** A session moves between owners: its compactions and prewarms hand it to a new run. */
  readonly moves: boolean;
  /** A session's run can be cancelled outside eve, as an operator does (`cancelRunOutsideEve`). */
  readonly externalCancel: boolean;
  /** Each session's run records the eve version that owns it (`rewriteRunAttributes`). */
  readonly stamps: boolean;
}

/** One step's completion, as a fault sees it. In process, only turn steps are steps. */
export interface CompletingStep {
  readonly name: string;
  /** The session or run the step belongs to. */
  readonly runId: string;
}

/** Faults a test injects into a host's steps. */
export interface StepFaultPlan {
  /** Whether `step` loses its completion, as when its process exits before it commits. */
  loseCompletion?(step: CompletingStep): boolean;
  /** How many turn-step attempts, from the first, fail their first session write. */
  readonly failFirstWrites?: number;
}

export interface HostSetup {
  /** The plain bodies of the test agent's `"use workflow"` tools, which the in-process host runs. */
  readonly workflows?: readonly WorkflowBody[];
  readonly faults?: StepFaultPlan;
}

export interface HostUnderTest {
  readonly name: HostName;
  readonly runtime: Runtime;
  readonly capabilities: HostCapabilities;
  /**
   * Resolves once nothing in the host is working: no step, delivery or session start is in
   * flight, so every session and run waits on a message, a person or a timer. Read from the
   * host's own bookkeeping, with no quiet window.
   */
  settled(): Promise<void>;
  /** How many session writes the faults failed so far. */
  failedWrites(): number;
  /** How many workflow tool runs (tools, tasks, subagents) the host started so far. */
  workflowRunsStarted(): Promise<number>;
  /**
   * Drops the process and keeps the World: sessions and runs recover as at a boot. `beforeStart`
   * runs while nothing is running. Durable hosts only.
   */
  restart?(options?: { readonly beforeStart?: () => Promise<void> }): Promise<void>;
  /** Cancels a session's run outside eve. */
  cancelRunOutsideEve?(sessionId: string): Promise<void>;
  /** The waits the host stored. */
  storedWaits?(): Promise<StoredWait[]>;
  /**
   * Fails the next stored wait due within `dueWithinMs` before its event is journaled, as a crash
   * between the two does.
   */
  crashBeforeNextWaitEvent?(dueWithinMs: number): Promise<void>;
  /** A session run's status, as the host records it. */
  runStatus?(runId: string): Promise<string>;
  /** Rewrites a stopped session run's attributes; call it from `restart`'s `beforeStart`. */
  rewriteRunAttributes?(runId: string, patch: Record<string, string | undefined>): Promise<void>;
  /** Stops what the test left running, so the next case starts clean. */
  dispose(): Promise<void>;
}

/** A kind of host: what it can do, and how to make one for a case. */
export interface SessionHostKind {
  readonly capabilities: HostCapabilities;
  /** Makes a host for one case. Call it inside the test runtime's `run`. */
  make(setup?: HostSetup): Promise<HostUnderTest>;
}

/** Where an in-process session's sign-in callbacks point; tests read only their path. */
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
  make: makeWorkflowHost,
};

async function makeInProcessHost(setup: HostSetup = {}): Promise<HostUnderTest> {
  const failed = { writes: 0 };
  const runtime = createInProcessRuntime(
    { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
    {
      callbackBaseUrl: IN_PROCESS_CALLBACK_BASE_URL,
      // Workflow's own step serializer, so a payload a deployment couldn't carry fails here too.
      stepBoundary: workflowStepBoundary,
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
      const recovered = await testWorld.restart(options);
      // What this realm kept of each session is the dead process's.
      for (const runId of recovered) forgetSessionLive(runId);
    },
    async cancelRunOutsideEve(sessionId) {
      await cancelRun(testWorld.world, sessionId);
    },
    storedWaits: () => testWorld.storedWaits(),
    crashBeforeNextWaitEvent: (dueWithinMs) => testWorld.crashBeforeNextWaitEvent(dueWithinMs),
    runStatus: async (runId) =>
      (await testWorld.world.runs.get(runId, { resolveData: "none" })).status,
    rewriteRunAttributes: (runId, patch) => testWorld.rewriteRunAttributes(runId, patch),
    async dispose() {
      faults?.restore();
      // The file's World outlives the case: end what it left running, so a later restart in this
      // file doesn't recover it.
      await testWorld.idle();
      for (const runId of await testWorld.activeRunIds()) {
        await cancelRun(testWorld.world, runId).catch(() => {});
      }
      await testWorld.idle();
    },
  };
}

/** The in-process host's step faults for `plan`. */
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

/**
 * Workflow's step faults for `plan`: a lost completion is a `step_completed` event the World
 * refuses, as a process that exits before the step commits leaves it, and the queue redelivers it
 * at once instead of after its backoff. A failed write is the first write of a turn-step attempt.
 * With batching off, every event goes through `create`, so none can skip the fault.
 */
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
