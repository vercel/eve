import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { expectScheduleRun, SCHEDULE_ADAPTER_KIND, ScheduleDispatcher } from "#channel/schedule.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
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

/**
 * Pins the on-disk → compile → resolve → dispatch → rehydrate path for
 * channel-less schedules.
 *
 * Pre-fix, every markdown schedule (and every TS schedule without a
 * `channel` field) failed at the first workflow step boundary with
 *
 *     Unknown adapter kind: "schedule". Declare the adapter on the route
 *     that starts this session so the runtime can rehydrate it.
 *
 * because `FRAMEWORK_ADAPTERS` only registered `"http"` and `"subagent"`,
 * leaving `{ kind: "schedule" }` (emitted by `ScheduleDispatcher.trigger`
 * when no channel is configured) unrehydratable. Markdown schedules are
 * forbidden from declaring a channel
 * (`packages/eve/src/internal/helpers/markdown.ts`), so 100% of them hit
 * this path. TS schedules with no channel hit the same path.
 *
 * This test materializes both forms, drives the real `ScheduleDispatcher`
 * with a stub workflow runtime that simulates a step boundary, and
 * asserts that the bundle's adapter registry can rehydrate the dispatched
 * adapter — locking the fix that registered `SCHEDULE_ADAPTER` as a
 * framework adapter.
 */

const createAppRoot = useTemporaryAppRoots();
const APP_ROOT_OPTIONS = { packageName: "schedule-trigger-test-agent" } as const;

interface CapturedRun {
  readonly adapter: ChannelAdapter;
  readonly input: { readonly message: string };
}

function createCapturingRuntime(captured: CapturedRun[]): Runtime {
  return {
    async cancelTurn() {
      throw new Error("cancelTurn should not be called in this scenario");
    },
    async resolveSession() {
      throw new Error("resolveSession should not be called in this scenario");
    },
    async run(input) {
      captured.push({
        adapter: input.adapter,
        input: input.input as { message: string },
      });

      const handle: RunHandle = {
        continuationToken: "scenario-token",
        events: new ReadableStream<HandleMessageStreamEvent>(),
        sessionId: "scenario-session",
      };
      return handle;
    },
    async deliver() {
      throw new Error("deliver should not be called in this scenario");
    },
    async getEventStream() {
      return new ReadableStream<HandleMessageStreamEvent>();
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

  // Round-trip through the real bundle's adapter registry the way the
  // workflow runtime would at the first `"use step"` boundary.
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
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    // Markdown schedules cannot declare a channel
    // (`internal/helpers/markdown.ts`), so this is the broken-by-default
    // path users hit in production.
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

      // Resolve the schedule the same way the Nitro task handler does.
      const registrations = createScheduleRegistrations(schedules);
      expect(registrations).toHaveLength(1);
      const schedule = await loadResolvedCompiledScheduleByTaskName(registrations[0]!.taskName, {
        compiledArtifactsSource,
      });

      // Drive the real ScheduleDispatcher with a capturing runtime so
      // we can observe exactly what shape the runtime would be asked
      // to durably persist.
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

      // Simulate the first workflow step boundary by round-tripping
      // the dispatched adapter through the real bundle's adapter
      // registry. Pre-fix, this throws "Unknown adapter kind:
      // \"schedule\"".
      const rehydrated = await simulateStepBoundary(captured[0]!.adapter, bundle);

      expect(rehydrated).toEqual({ kind: SCHEDULE_ADAPTER_KIND, state: {} });
    });
  });

  it("rehydrates a TypeScript schedule's adapter when the schedule has no channel", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-schedule-trigger-ts-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    // TS schedule without a `channel` — the bug is not actually
    // markdown-specific; the markdown form only stood out because it
    // is the form that's forbidden from declaring a channel.
    await writeFile(
      join(agentRoot, "schedules", "heartbeat.mjs"),
      'export default { cron: "*/1 * * * *", markdown: "Heartbeat — no channel." };\n',
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

      expect(rehydrated).toEqual({ kind: SCHEDULE_ADAPTER_KIND, state: {} });
    });
  });

  /**
   * Locks the load path the Nitro cron handler uses for a `run`-handler
   * schedule. Pre-fix, `collectModuleRefsForManifest` omitted
   * `manifest.schedules` from the compiled module map, so this load
   * threw `ResolveAgentError: Missing compiled module namespace ...`.
   * The previous `hasRun: false` cases above never loaded the source.
   */
  it("loads the default export of a TypeScript schedule with a run() handler", async () => {
    const { agentRoot, appRoot } = await createAppRoot(
      "eve-schedule-trigger-run-",
      APP_ROOT_OPTIONS,
    );

    await mkdir(join(agentRoot, "schedules"), { recursive: true });
    await writeFile(join(agentRoot, "agent.mjs"), 'export default { model: "openai/gpt-5.4" };\n');
    await writeFile(join(agentRoot, "instructions.md"), "You are a precise assistant.\n");
    // `defineSchedule` is identity; the literal object avoids depending
    // on the framework package being resolvable from the temp app root.
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

      // `run` only calls `waitUntil`; no `receive(...)`, no sessions.
      expect(captured).toHaveLength(0);
    });
  });
});
