import { describe, expect, it } from "vitest";

import { createCompiledChannelRoutePlan } from "#compiler/channel-route-plan.js";
import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledChannelDefinition } from "#compiler/manifest.js";
import type { CompiledModuleBinding } from "#compiler/module-binding.js";
import {
  createStubCompiledAgentManifest,
  createStubCompiledAgentNodeManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import {
  createCompilerDiagnosticsArtifact,
  compilerDiagnosticsArtifactSchema,
  validateCompilerDiagnosticsArtifactSemantics,
} from "#protocol/compiler-diagnostics-artifact.js";
import type { CompilerDiagnostic } from "#shared/compiler-diagnostics.js";

describe("compiler diagnostics artifact semantics", () => {
  it("rejects the previous artifact schema instead of repairing it", () => {
    expect(
      compilerDiagnosticsArtifactSchema.safeParse({
        diagnostics: [],
        kind: "eve-compiler-diagnostics",
        summary: { errors: 0, warnings: 0 },
        version: 2,
      }).success,
    ).toBe(false);
  });

  it("round-trips a programmatic route warning without fabricating physical paths", () => {
    const fixture = createShadowedRouteFixture();

    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: fixture.artifact,
        manifest: fixture.manifest,
      }),
    ).toEqual([]);
    expect(fixture.artifact.diagnostics).toEqual([
      expect.objectContaining({
        channelRoute: { method: "GET", pathPattern: "/users/:_" },
        logicalPath: "channels/loser.ts",
        sourceId: "opaque:loser",
      }),
    ]);
    expect(fixture.artifact.diagnostics[0]).not.toHaveProperty("sourcePath");
    expect(fixture.artifact.diagnostics[0]?.related?.[0]).not.toHaveProperty("sourcePath");
  });

  it("rejects physical paths on primary and related programmatic locators", () => {
    const fixture = createShadowedRouteFixture();
    const warning = fixture.artifact.diagnostics[0]!;
    const artifact = createCompilerDiagnosticsArtifact([
      {
        ...warning,
        related: warning.related?.map((related) => ({
          ...related,
          sourcePath: "/fabricated/winner.ts",
        })),
        sourcePath: "/fabricated/loser.ts",
      },
    ]);

    expect(
      validateCompilerDiagnosticsArtifactSemantics({ artifact, manifest: fixture.manifest }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fabricates physical sourcePath "/fabricated/loser.ts"'),
        expect.stringContaining('fabricates physical sourcePath "/fabricated/winner.ts"'),
      ]),
    );
  });

  it("accepts a filesystem locator when another node reuses its source id programmatically", () => {
    const childNodeId = "subagents/child/agent.ts";
    const sourceId = "tools/shared.ts";
    const sourcePath = "/app/agent/subagents/child/tools/shared.ts";
    const childAgent = createStubCompiledAgentNodeManifest(
      {
        agentRoot: "/app/agent/subagents/child",
        appRoot: "/app",
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          {
            binding: {
              backing: { externalDependencies: [], kind: "filesystem", sourcePath },
              owner: { kind: "application" },
            },
            logicalPath: sourceId,
            sourceId,
          },
        ],
        config: {
          model: { id: "openai/gpt-5.5", routing: { kind: "gateway", target: "openai" } },
          name: "child",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        diagnosticsSummary: { errors: 0, warnings: 1 },
        tools: [
          {
            description: "Shared.",
            inputSchema: null,
            logicalPath: sourceId,
            name: "shared",
            sourceId,
            sourceKind: "module",
          },
        ],
      },
      { isRoot: false, nodeId: childNodeId },
    );
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING, { logicalPath: sourceId, sourceId }],
      config: {
        model: { id: "openai/gpt-5.5", routing: { kind: "gateway", target: "openai" } },
        name: "root",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      diagnosticsSummary: { errors: 0, warnings: 1 },
      tools: [
        {
          description: "Shared root tool.",
          inputSchema: null,
          logicalPath: sourceId,
          name: "shared",
          sourceId,
          sourceKind: "module",
        },
      ],
      subagentEdges: [{ childNodeId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID }],
      subagents: [
        {
          agent: childAgent,
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/subagents/child/agent.ts",
          },
          description: "Child.",
          entryPath: "/app/agent/subagents/child/agent.ts",
          logicalPath: "subagents/child",
          name: "child",
          nodeId: childNodeId,
          owner: { kind: "application" },
          rootPath: "/app/agent/subagents/child",
          sourceId: "subagents/child/agent.ts",
          sourceKind: "subagent",
        },
      ],
    });
    const artifact = createCompilerDiagnosticsArtifact([
      {
        code: "compile/test-warning",
        logicalPath: sourceId,
        message: "Test warning.",
        nodeId: childNodeId,
        severity: "warning",
        sourceId,
        sourcePath,
      },
    ]);

    expect(validateCompilerDiagnosticsArtifactSemantics({ artifact, manifest })).toEqual([]);
    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: createCompilerDiagnosticsArtifact([
          { ...artifact.diagnostics[0]!, nodeId: ROOT_COMPILED_AGENT_NODE_ID },
        ]),
        manifest,
      }),
    ).toContainEqual(expect.stringContaining(`fabricates physical sourcePath "${sourcePath}"`));
  });

  it("requires an exact one-to-one warning relationship in both directions", () => {
    const fixture = createShadowedRouteFixture();
    const warning = fixture.artifact.diagnostics[0]!;
    const wrongWinner: CompilerDiagnostic = {
      ...warning,
      related: [
        {
          label: "winner",
          logicalPath: "channels/other.ts",
          nodeId: warning.nodeId,
          sourceId: "opaque:winner",
        },
      ],
    };

    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: createCompilerDiagnosticsArtifact([]),
        manifest: fixture.manifest,
      }),
    ).toContainEqual(expect.stringContaining("has no exact compile/channel-route-shadowed"));
    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: createCompilerDiagnosticsArtifact([wrongWinner]),
        manifest: fixture.manifest,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has no exact channelRoutes.shadowed record"),
        expect.stringContaining("has no exact compile/channel-route-shadowed"),
      ]),
    );
    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: createCompilerDiagnosticsArtifact([warning, warning]),
        manifest: {
          ...fixture.manifest,
          diagnosticsSummary: { errors: 0, warnings: 2 },
        },
      }),
    ).toContainEqual(expect.stringContaining("has no exact channelRoutes.shadowed record"));
  });

  it("distinguishes multiple routes from the same loser and winner source pair", () => {
    const fixture = createShadowedRouteFixture({ multipleRoutes: true });

    expect(fixture.artifact.diagnostics).toHaveLength(2);
    expect(
      fixture.artifact.diagnostics.map((diagnostic) => ({
        channelRoute: diagnostic.channelRoute,
        loser: diagnostic.sourceId,
        winner: diagnostic.related?.[0]?.sourceId,
      })),
    ).toEqual([
      {
        channelRoute: { method: "GET", pathPattern: "/users/:_" },
        loser: "opaque:loser",
        winner: "opaque:winner",
      },
      {
        channelRoute: { method: "POST", pathPattern: "/projects/:_" },
        loser: "opaque:loser",
        winner: "opaque:winner",
      },
    ]);
    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: fixture.artifact,
        manifest: fixture.manifest,
      }),
    ).toEqual([]);
  });

  it("requires a route warning to retain its root node identity", () => {
    const fixture = createShadowedRouteFixture();
    const warning = fixture.artifact.diagnostics[0]!;
    expect(
      validateCompilerDiagnosticsArtifactSemantics({
        artifact: createCompilerDiagnosticsArtifact([
          {
            ...warning,
            nodeId: "subagents/child",
            related: warning.related?.map((related) => ({
              ...related,
              nodeId: "subagents/child",
            })),
          },
        ]),
        manifest: fixture.manifest,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has no exact channelRoutes.shadowed record"),
        expect.stringContaining("has no exact compile/channel-route-shadowed"),
      ]),
    );
  });
});

function createShadowedRouteFixture(options: { multipleRoutes?: boolean } = {}) {
  const diagnostics: CompilerDiagnostic[] = [];
  const bindings: Record<string, CompiledModuleBinding> = {
    "opaque:loser": {
      backing: {
        kind: "programmatic",
        moduleId: "loser",
        registryId: "test-routes",
        revision: "test-revision",
      },
      logicalPath: "channels/loser.ts",
      owner: { feature: "test-routes", kind: "framework" },
    },
    "opaque:winner": {
      backing: {
        kind: "programmatic",
        moduleId: "winner",
        registryId: "test-routes",
        revision: "test-revision",
      },
      logicalPath: "channels/winner.ts",
      owner: { kind: "application" },
    },
  };
  const channelRoutes = createCompiledChannelRoutePlan({
    bindings,
    diagnostics,
    nodeId: ROOT_COMPILED_AGENT_NODE_ID,
    routes:
      options.multipleRoutes === true
        ? [
            route("opaque:winner", "channels/winner.ts", "GET", "/users/:id"),
            route("opaque:winner", "channels/winner.ts", "POST", "/projects/:id"),
            route("opaque:loser", "channels/loser.ts", "GET", "/users/:name"),
            route("opaque:loser", "channels/loser.ts", "POST", "/projects/:name"),
          ]
        : [
            route("opaque:winner", "channels/winner.ts", "GET", "/users/:id"),
            route("opaque:loser", "channels/loser.ts", "GET", "/users/:name"),
          ],
  });
  const artifact = createCompilerDiagnosticsArtifact(diagnostics);
  const manifest = createStubCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: [
      TEST_COMPILED_AGENT_CONFIG_BINDING,
      ...Object.entries(bindings).map(([sourceId, binding]) => ({
        binding,
        logicalPath: binding.logicalPath,
        sourceId,
      })),
    ],
    channelRoutes,
    config: {
      model: { id: "openai/gpt-5.5", routing: { kind: "gateway", target: "openai" } },
      name: "diagnostics-test",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    diagnosticsSummary: artifact.summary,
  });

  return { artifact, manifest };
}

function route(
  sourceId: string,
  logicalPath: string,
  method: CompiledChannelDefinition["method"],
  urlPath: string,
): CompiledChannelDefinition {
  return {
    kind: "channel",
    logicalPath,
    method,
    name: logicalPath,
    sourceId,
    sourceKind: "module",
    urlPath,
  };
}
