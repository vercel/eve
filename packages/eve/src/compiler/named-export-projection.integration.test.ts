import { describe, expect, it } from "vitest";

import { expectScheduleRun, ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime } from "#channel/types.js";
import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import {
  createAgentSourceRegistry,
  composeAgentSourceRegistries,
} from "#compiler/agent-source-registry.js";
import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { finalizeProgrammaticWorkspaceResources } from "#compiler/workspace-resources.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { experimental_workflow } from "#public/definitions/tool.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineSkill } from "#public/definitions/skill.js";
import { webSearch } from "#public/tools/web-search.js";
import { resolveAgent } from "#runtime/resolve-agent.js";
import { loadResolvedModuleExport } from "#runtime/resolve-helpers.js";
import { resolveSchedules } from "#runtime/schedules/resolve-schedule.js";

describe("named-export compiled projections", () => {
  it("preserves every previously omitted named export through dispatch and inspection", async () => {
    const executedRuns: string[] = [];
    const source = defineProgrammaticAgentSource({
      id: "named-export-projection",
      revision: "v1",
      modules: [
        {
          exportName: "namedInstructions",
          loadNamespace: () => ({
            default: defineInstructions({ content: "Wrong instructions." }),
            namedInstructions: defineInstructions({
              content: "Exact named instructions.",
              role: "user",
            }),
          }),
          logicalPath: "instructions.ts",
        },
        {
          exportName: "namedSchedule",
          loadNamespace: () => ({
            default: defineSchedule({
              cron: "0 0 * * *",
              run() {
                executedRuns.push("default");
              },
            }),
            namedSchedule: defineSchedule({
              cron: "0 9 * * *",
              run() {
                executedRuns.push("named");
              },
            }),
          }),
          logicalPath: "schedules/digest.ts",
        },
        {
          exportName: "namedSkill",
          loadNamespace: () => ({
            default: defineSkill({ description: "Wrong skill.", markdown: "# Wrong\n" }),
            namedSkill: defineSkill({
              description: "Exact named skill.",
              markdown: "# Exact\n",
            }),
          }),
          logicalPath: "skills/exact.ts",
        },
        {
          exportName: "namedWorkflow",
          loadNamespace: () => ({
            default: experimental_workflow({ maxSubagents: 1 }),
            namedWorkflow: experimental_workflow({ maxSubagents: 7 }),
          }),
          logicalPath: "tools/workflow.ts",
        },
        {
          exportName: "namedWebSearch",
          loadNamespace: () => ({
            default: webSearch({ provider: "exa" }),
            namedWebSearch: webSearch({ provider: "parallel" }),
          }),
          logicalPath: "tools/web_search.ts",
        },
      ],
    });
    const applicationRegistry = createAgentSourceRegistry([{ applyTo: "root", source }]);
    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "named-export-agent",
        agentRoot: "/virtual/app/agent",
        appRoot: "/virtual/app",
      }),
      {
        modelCatalog: {
          async getByProviderModelId() {
            return null;
          },
          async getModelLimits() {
            return { contextWindowTokens: 128_000, maxOutputTokens: 32_000 };
          },
        },
        registry: applicationRegistry,
      },
    );
    const manifest = parseCompiledAgentManifest(
      JSON.parse(JSON.stringify(finalizeProgrammaticWorkspaceResources({ manifest: compiled }))),
    );

    expect(manifest.instructions).toContainEqual(
      expect.objectContaining({
        content: "Exact named instructions.",
        exportName: "namedInstructions",
        role: "user",
      }),
    );
    expect(manifest.skills).toContainEqual(
      expect.objectContaining({
        description: "Exact named skill.",
        exportName: "namedSkill",
      }),
    );
    expect(manifest.workflowTool).toEqual(
      expect.objectContaining({
        exportName: "namedWorkflow",
        maxSubagents: 7,
        sourceId: "named-export-projection:tools/workflow.ts",
      }),
    );
    expect(manifest.webSearchProvider).toEqual(
      expect.objectContaining({
        exportName: "namedWebSearch",
        provider: "parallel",
        sourceId: "named-export-projection:tools/web_search.ts",
      }),
    );

    const registry = composeAgentSourceRegistries([
      frameworkAgentSourceRegistry,
      applicationRegistry,
    ]);
    const moduleMap = await createProgrammaticCompiledModuleMap({ manifest, registry });
    const resolvedAgent = await resolveAgent({ manifest, moduleMap });
    expect(resolvedAgent.instructions).toContainEqual(
      expect.objectContaining({ exportName: "namedInstructions" }),
    );
    expect(resolvedAgent.skills).toContainEqual(
      expect.objectContaining({ exportName: "namedSkill" }),
    );
    expect(resolvedAgent.workflowTool).toEqual({ maxSubagents: 7 });
    expect(resolvedAgent.webSearchProvider).toBe("parallel");

    const [schedule] = await resolveSchedules({ manifest });
    if (schedule?.sourceKind !== "module") throw new Error("Expected a module schedule.");
    expect(schedule.exportName).toBe("namedSchedule");
    const exportValue = await loadResolvedModuleExport({
      definition: schedule,
      kindLabel: "schedule",
      moduleMap,
      nodeId: undefined,
    });
    const run = expectScheduleRun(exportValue, schedule.logicalPath, schedule.exportName);
    await new ScheduleDispatcher({ channels: [], runtime: createInertRuntime() }).trigger({
      run,
      scheduleId: schedule.name,
    });
    expect(executedRuns).toEqual(["named"]);

    const info = buildAgentInfoResponse(
      { manifest },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "development",
      },
    );
    expect(AgentInfoResultSchema.parse(info)).toEqual(info);
    expect(info.instructions.static).toContainEqual(
      expect.objectContaining({ exportName: "namedInstructions" }),
    );
    expect(info.skills.static).toContainEqual(
      expect.objectContaining({ exportName: "namedSkill" }),
    );
    expect(info.schedules).toContainEqual(expect.objectContaining({ exportName: "namedSchedule" }));
    expect(
      info.composition.selected.find((entry) => entry.slot === "tools/workflow")?.source.exportName,
    ).toBe("namedWorkflow");
    expect(
      info.composition.selected.find((entry) => entry.slot === "tools/web_search")?.source
        .exportName,
    ).toBe("namedWebSearch");
  });
});

function createInertRuntime(): Runtime {
  return {
    async createSession() {
      throw new Error("The named schedule should not create a session.");
    },
    async dispatchContinuation() {
      throw new Error("The named schedule should not dispatch a continuation.");
    },
    async dispatchSession() {
      throw new Error("The named schedule should not dispatch a session.");
    },
    async getEventStream() {
      return new ReadableStream<MessageStreamEvent>();
    },
    async getStreamTailIndex() {
      return -1;
    },
    async resolveContinuation() {
      throw new Error("The named schedule should not resolve a continuation.");
    },
  };
}
