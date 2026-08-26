import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { experimental_workflow } from "#tools/workflow.js";
import { webSearch } from "#tools/provided/web-search.js";
import { defineMemory } from "#public/memory/index.js";

describe("buildAgentInfoResponse", () => {
  it("projects v4 exclusively from the effective compiled graph", async () => {
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
      version: 4,
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

  it("reports selected memory and provider-tool wrapper provenance", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              description: "Caller profile.",
              provider: {
                recall: { "turn.started": async () => null },
                tools: async () => ({}),
              },
              scope: "user_1",
            }),
          }),
          logicalPath: "memory/profile.ts",
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

    expect(response.memories).toContainEqual(
      expect.objectContaining({
        description: "Caller profile.",
        slot: "profile",
        visibility: "scope",
      }),
    );
    expect(response.tools.dynamic).toContainEqual(
      expect.objectContaining({
        binding: expect.objectContaining({
          backing: expect.objectContaining({
            dependencies: { memory: response.memories[0]?.sourceId },
            parameters: expect.objectContaining({ slot: "profile" }),
          }),
        }),
        slug: "profile",
      }),
    );
    expect(() => AgentInfoResultSchema.parse(response)).not.toThrow();
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
        expect.objectContaining({ action: "task-cancel", audience: [], kind: "dispatch" }),
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
