import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { experimental_workflow } from "#public/definitions/tool.js";
import { webSearch } from "#tools/web-search.js";

describe("buildAgentInfoResponse", () => {
  it("projects v3 exclusively from the effective compiled graph", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      name: "info-agent",
      tools: [{ name: "weather" }],
    });

    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: true, oidc: false },
        mode: "development",
      },
    );

    expect(response).toMatchObject({
      agent: {
        model: {
          endpoint: { connected: true, credential: "api-key", kind: "gateway" },
          id: "openai/gpt-5.4",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "info-agent",
        nodeId: "__root__",
      },
      capabilities: { devRoutes: true },
      kind: "eve-agent-info",
      version: 3,
    });
    expect(response.tools.static).toContainEqual(
      expect.objectContaining({
        name: "weather",
        owner: { kind: "application" },
        sourceKind: "module",
      }),
    );
    expect(response.channels.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", urlPath: "/eve/v1/health" }),
        expect.objectContaining({ method: "GET", urlPath: "/eve/v1/info" }),
      ]),
    );
    expect(response.sandbox).toMatchObject({
      logicalPath: "sandbox.ts",
      owner: { feature: "eve:defaults", kind: "framework" },
    });
    expect(response.composition.shadowed).toContainEqual(
      expect.objectContaining({
        logicalPath: "agent.ts",
        owner: { feature: "eve:defaults", kind: "framework" },
        winnerSourceId: "memory:info-agent:agent.ts",
      }),
    );
  });

  it("derives kernel effects only from active framework-owned canonical slots", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );

    expect(response.kernelEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "request-input" }),
        expect.objectContaining({ action: "subagent-call", kind: "dispatch" }),
      ]),
    );
  });

  it("reports selected instrumentation provenance from the compiled graph", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({ default: defineInstrumentation({}) }),
          logicalPath: "instrumentation.ts",
        },
      ],
    });
    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );

    expect(response.instrumentation).toMatchObject({
      binding: { backing: { kind: "programmatic" } },
      logicalPath: "instrumentation.ts",
      owner: { kind: "application" },
    });
  });

  it("reports selected Workflow provenance from the compiled graph", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({ default: experimental_workflow({ maxSubagents: 5 }) }),
          logicalPath: "tools/workflow.ts",
        },
      ],
    });
    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );

    expect(response.workflow).toMatchObject({
      enabled: true,
      source: {
        binding: { backing: { kind: "programmatic" } },
        logicalPath: "tools/workflow.ts",
        owner: { kind: "application" },
      },
      toolName: "Workflow",
    });
  });

  it("reports an authored webSearch sentinel as a prepared provider effect", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({ default: webSearch({ provider: "parallel" }) }),
          logicalPath: "tools/web_search.ts",
        },
      ],
    });
    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );

    expect(response.kernelEffects).toContainEqual(
      expect.objectContaining({
        kind: "provider-tool",
        sourceId: expect.stringContaining("tools/web_search.ts"),
      }),
    );
  });
});
