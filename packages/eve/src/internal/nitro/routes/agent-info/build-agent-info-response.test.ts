import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "#compiled/zod/index.js";
import type { AgentInfoResult } from "#client/agent-info-types.js";
import { HealthResultSchema, type HealthResult } from "#client/health-schema.js";

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

import type { CompiledShadowedChannelRoute } from "#compiler/manifest.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { webSearch } from "#tools/provided/web-search.js";
import { defineMemory } from "#public/memory/index.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineSchedule } from "#public/definitions/schedule.js";

describe("buildAgentInfoResponse", () => {
  it("keeps the public inspection and health contracts aligned with their validators", () => {
    type ValidatedInfo = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
    // Flatten interfaces and intersections while preserving keys and modifiers.
    type Shape<T> = T extends object ? { [K in keyof T]: Shape<T[K]> } : T;
    expectTypeOf<Shape<AgentInfoResult>>().toEqualTypeOf<Shape<ValidatedInfo>>();
    expectTypeOf<HealthResult>().toEqualTypeOf<z.output<typeof HealthResultSchema>>();
  });

  it("projects agent info exclusively from the effective compiled graph", async () => {
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
      version: 6,
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

  it("omits authored text and server paths, keeping instruction text for development only", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({
            default: defineInstructions({ content: "canary-instructions", role: "system" }),
          }),
          logicalPath: "instructions/policy.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineSchedule({ cron: "0 9 * * *", content: "canary-schedule" }),
          }),
          logicalPath: "schedules/digest.ts",
        },
      ],
      skills: [{ description: "Research skill.", markdown: "canary-skill", name: "research" }],
    });
    const build = (mode: "development" | "production") =>
      buildAgentInfoResponse(
        { manifest, schedules: [] },
        { gatewayCredentials: { apiKey: false, oidc: false }, mode },
      );

    const production = build("production");
    const serialized = JSON.stringify(production);
    expect(serialized).not.toContain("canary-instructions");
    expect(serialized).not.toContain("canary-schedule");
    expect(serialized).not.toContain("canary-skill");
    expect(production.agent).not.toHaveProperty("appRoot");
    expect(production.agent).not.toHaveProperty("agentRoot");
    expect(production.instructions.static).toContainEqual(
      expect.objectContaining({ logicalPath: "instructions/policy.ts", role: "system" }),
    );
    expect(production.instructions.static.every((entry) => entry.content === undefined)).toBe(true);
    expect(production.schedules).toHaveLength(1);
    expect(production.schedules[0]).not.toHaveProperty("markdown");
    expect(production.skills.static.find((entry) => entry.name === "research")).not.toHaveProperty(
      "markdown",
    );
    expect(production.skills.static).toContainEqual(
      expect.objectContaining({ description: "Research skill.", name: "research" }),
    );
    expect(() => AgentInfoResultSchema.parse(production)).not.toThrow();

    const development = build("development");
    expect(development.instructions.static).toContainEqual(
      expect.objectContaining({
        content: "canary-instructions",
        logicalPath: "instructions/policy.ts",
      }),
    );
    expect(JSON.stringify(development)).not.toContain("canary-skill");
    expect(JSON.stringify(development)).not.toContain("canary-schedule");
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
    expect(response.agent.config.binding).not.toHaveProperty("usage");
    expect(response.memories[0]?.binding).not.toHaveProperty("usage");
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
        expect.objectContaining({ action: "subagent-call", kind: "dispatch" }),
      ]),
    );
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

  it("only exposes the priority tier from providerOptions", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      name: "info-agent",
    });
    const model = manifest.config.model;
    if (model === undefined) throw new Error("Expected a static compiled model.");
    // The shipped BYOK scaffold places the owner's provider key under
    // `gateway.byok`; a custom provider may carry other credential fields.
    model.providerOptions = {
      gateway: {
        byok: { openai: [{ apiKey: "sk-canary-byok" }] },
        serviceTier: "priority",
      },
      openai: {
        apiKey: "sk-canary-direct",
        headers: { authorization: "Bearer canary-header" },
        reasoningEffort: "high",
        metadata: { workspace: "sk-canary-unrecognized" },
      },
    };

    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("sk-canary-byok");
    expect(serialized).not.toContain("sk-canary-direct");
    expect(serialized).not.toContain("canary-header");
    expect(serialized).not.toContain("sk-canary-unrecognized");
    // Non-secret options survive for the dev TUI (`gateway.serviceTier`).
    expect(response.agent.model.providerOptions).toEqual({
      gateway: { serviceTier: "priority" },
    });

    model.providerOptions = { gateway: { serviceTier: "sk-canary-tier" } };
    const customTierResponse = buildAgentInfoResponse(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "production",
      },
    );
    expect(customTierResponse.agent.model.providerOptions).toBeUndefined();
    expect(JSON.stringify(customTierResponse)).not.toContain("sk-canary-tier");
  });

  it("sends the ChatGPT account label only from development servers", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const model = manifest.config.model;
    if (model === undefined) throw new Error("Expected a static compiled model.");
    model.routing = { kind: "external", provider: "codex" };
    const build = (mode: "development" | "production") =>
      buildAgentInfoResponse(
        { manifest, schedules: [] },
        {
          chatgptAuth: { accountLabel: "canary@example.com", kind: "ready" },
          gatewayCredentials: { apiKey: false, oidc: false },
          mode,
        },
      );

    expect(build("development").agent.model.endpoint).toEqual({
      accountLabel: "canary@example.com",
      kind: "chatgpt",
      state: "ready",
    });
    expect(build("production").agent.model.endpoint).toEqual({ kind: "chatgpt", state: "ready" });
  });

  it("projects shadowed routes and backings without server paths", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const owner = { kind: "application" as const };
    const shadowed = (backing: CompiledShadowedChannelRoute["source"]["backing"]) => ({
      method: "GET" as const,
      source: {
        backing,
        form: "direct" as const,
        layer: "application" as const,
        logicalPath: "channels/status.ts",
        owner,
        sourceId: "channels/status.ts",
      },
      urlPath: "/status",
      winnerSourceId: "channels/status-v2.ts",
    });
    const response = buildAgentInfoResponse(
      {
        manifest: {
          ...manifest,
          channelRoutes: {
            ...manifest.channelRoutes,
            shadowed: [
              shadowed({ kind: "resource", sourcePath: "/srv/canary/agent/channels/status.ts" }),
              shadowed({
                externalDependencies: ["zod"],
                extensionScope: { namespace: "crm", sourceRoot: "/srv/canary/extensions/crm" },
                kind: "filesystem",
                mountId: "extensions/crm",
                sourcePath: "/srv/canary/extensions/crm/channels/status.ts",
              }),
            ],
          },
        },
        schedules: [],
      },
      { gatewayCredentials: { apiKey: false, oidc: false }, mode: "production" },
    );

    expect(JSON.stringify(response)).not.toContain("/srv/canary");
    expect(response.channels.shadowed.map((route) => route.source.backing)).toEqual([
      { kind: "resource" },
      {
        externalDependencies: ["zod"],
        extensionScope: { namespace: "crm" },
        kind: "filesystem",
        mountId: "extensions/crm",
      },
    ]);
    expect(() => AgentInfoResultSchema.parse(response)).not.toThrow();
  });
});
