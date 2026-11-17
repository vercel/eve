import type { SessionStreamEvent } from "#protocol/session-event.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { expectScheduleRun, SCHEDULE_ADAPTER_KIND, ScheduleDispatcher } from "#channel/schedule.js";
import type { RunHandle, Runtime } from "#channel/types.js";
import { compileAgent } from "#compiler/compile-agent.js";
import { ContextContainer } from "#context/container.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { loadResolvedCompiledScheduleByTaskName } from "#runtime/schedules/resolve-schedule.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const createAppRoot = useTemporaryAppRoots();
const APP_ROOT_OPTIONS = { packageName: "schedule-trigger-test-agent" } as const;

interface CapturedRun {
  readonly adapter: ChannelAdapter;
  readonly input: { readonly message: string };
}

function createCapturingRuntime(captured: CapturedRun[]): Runtime {
  return {
    async createSession(input) {
      captured.push({
        adapter: input.adapter,
        input: input.input as { message: string },
      });

      const handle: RunHandle = {
        events: new ReadableStream<SessionStreamEvent>(),
        sessionId: "scenario-session",
      };
      return handle;
    },
    async dispatchContinuation() {
      throw new Error("dispatchContinuation should not be called in this scenario");
    },
    async dispatchSession() {
      throw new Error("dispatchSession should not be called in this scenario");
    },
    async getLineStream() {
      return new ReadableStream();
    },
    async getEventStream() {
      return new ReadableStream<SessionStreamEvent>();
    },
    async getStreamTailIndex() {
      return -1;
    },
    async resolveContinuation() {
      throw new Error("resolveContinuation should not be called in this scenario");
    },
  };
}

async function simulateStepBoundary(
  adapter: ChannelAdapter,
  bundle: CompiledBundle,
): Promise<ChannelAdapter> {
  const codec = ChannelKey.codec;
  if (codec === undefined) {
    throw new Error("ChannelKey codec missing — runtime cannot rehydrate adapters.");
  }

  const serialized = codec.serialize(adapter);
  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle);

  return await codec.deserialize(serialized, ctx);
}

describe("schedule trigger end-to-end (channel-less schedules)", () => {
  it("rehydrates a markdown schedule's adapter after a workflow step boundary", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-schedule-trigger-md-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), { recursive: true });
    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "schedules", "cleanup.md"),
      '---\ncron: "0 0 * * 0"\n---\nClean up stale data.\n',
    );

    await compileAgent({ startPath: appRoot });

    await withRuntimeSession(createRuntimeSession("schedule-trigger-md"), async () => {
      const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

      const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
      expect(schedules.map((s) => s.name)).toEqual(["cleanup"]);
      expect(schedules[0]?.sourceKind).toBe("markdown");
      expect(schedules[0]?.hasRun).toBe(false);

      const registrations = createScheduleRegistrations(schedules);
      expect(registrations).toHaveLength(1);
      const schedule = await loadResolvedCompiledScheduleByTaskName(registrations[0]!.taskName, {
        compiledArtifactsSource,
      });

      const captured: CapturedRun[] = [];
      const dispatcher = new ScheduleDispatcher({
        runtime: createCapturingRuntime(captured),
        channels: bundle.graph.root.channels,
      });

      const dispatchInput: { scheduleId: string; markdown?: string } = {
        scheduleId: schedule.name,
      };
      if (schedule.markdown !== undefined) {
        dispatchInput.markdown = schedule.markdown;
      }
      await dispatcher.trigger(dispatchInput);

      expect(captured).toHaveLength(1);
      expect(captured[0]!.input).toEqual({ message: "Clean up stale data." });
      expect(captured[0]!.adapter.kind).toBe(SCHEDULE_ADAPTER_KIND);

      const rehydrated = await simulateStepBoundary(captured[0]!.adapter, bundle);

      expect(rehydrated).toMatchObject({ kind: SCHEDULE_ADAPTER_KIND, state: {} });
    });
  });

  it("rehydrates a TypeScript schedule's adapter when the schedule has no channel", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-schedule-trigger-ts-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), { recursive: true });
    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "schedules", "heartbeat.mjs"),
      'export default { cron: "*/1 * * * *", content: "Heartbeat — no channel." };\n',
    );

    await compileAgent({ startPath: appRoot });

    await withRuntimeSession(createRuntimeSession("schedule-trigger-ts"), async () => {
      const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

      const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
      expect(schedules.map((s) => s.name)).toEqual(["heartbeat"]);
      expect(schedules[0]?.sourceKind).toBe("module");
      expect(schedules[0]?.hasRun).toBe(false);

      const registrations = createScheduleRegistrations(schedules);
      const schedule = await loadResolvedCompiledScheduleByTaskName(registrations[0]!.taskName, {
        compiledArtifactsSource,
      });

      const captured: CapturedRun[] = [];
      const dispatcher = new ScheduleDispatcher({
        runtime: createCapturingRuntime(captured),
        channels: bundle.graph.root.channels,
      });

      const dispatchInput: { scheduleId: string; markdown?: string } = {
        scheduleId: schedule.name,
      };
      if (schedule.markdown !== undefined) {
        dispatchInput.markdown = schedule.markdown;
      }
      await dispatcher.trigger(dispatchInput);

      expect(captured).toHaveLength(1);
      expect(captured[0]!.adapter.kind).toBe(SCHEDULE_ADAPTER_KIND);

      const rehydrated = await simulateStepBoundary(captured[0]!.adapter, bundle);

      expect(rehydrated).toMatchObject({ kind: SCHEDULE_ADAPTER_KIND, state: {} });
    });
  });

  it("loads the default export of a TypeScript schedule with a run() handler", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-schedule-trigger-run-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), { recursive: true });
    await writeFile(
      join(agentRoot, "agent.mjs"),
      'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
    );
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    await writeFile(
      join(agentRoot, "schedules", "daily-digest.mjs"),
      [
        "export default {",
        '  cron: "0 9 * * 1-5",',
        "  async run({ waitUntil }) {",
        "    waitUntil(Promise.resolve());",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await compileAgent({ startPath: appRoot });

    await withRuntimeSession(createRuntimeSession("schedule-trigger-run"), async () => {
      const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);

      const schedules = await loadResolvedCompiledSchedules({ compiledArtifactsSource });
      expect(schedules.map((s) => s.name)).toEqual(["daily-digest"]);
      expect(schedules[0]?.sourceKind).toBe("module");
      expect(schedules[0]?.hasRun).toBe(true);

      const registrations = createScheduleRegistrations(schedules);
      expect(registrations).toHaveLength(1);
      const schedule = await loadResolvedCompiledScheduleByTaskName(registrations[0]!.taskName, {
        compiledArtifactsSource,
      });

      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
      const exportValue = await loadResolvedModuleExport({
        definition: {
          logicalPath: schedule.logicalPath,
          sourceId: schedule.sourceId,
        },
        kindLabel: "schedule",
        moduleMap: bundle.moduleMap,
        nodeId: undefined,
      });
      const run = expectScheduleRun(exportValue, schedule.logicalPath, undefined);

      const captured: CapturedRun[] = [];
      const dispatcher = new ScheduleDispatcher({
        runtime: createCapturingRuntime(captured),
        channels: bundle.graph.root.channels,
      });

      await dispatcher.trigger({
        scheduleId: schedule.name,
        run,
      });

      expect(captured).toHaveLength(0);
    });
  });
});
