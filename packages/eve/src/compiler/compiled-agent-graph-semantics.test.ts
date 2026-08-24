import { describe, expect, it } from "vitest";

import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import {
  createStubCompiledAgentManifest,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

describe("compiled agent graph semantics", () => {
  it("rejects an extension-owned remote config binding without its extension scope", () => {
    const backing = {
      externalDependencies: [],
      extensionScope: { namespace: "acme-reviewer", sourceRoot: "/packages/reviewer" },
      kind: "filesystem" as const,
      sourcePath: "/packages/reviewer/agent.ts",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing,
      configResolver: {
        logicalPath: "subagents/reviewer.ts",
        sourceId: "subagents/reviewer::config",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: "/packages/reviewer/agent.ts",
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/reviewer",
      owner: { kind: "extension", namespace: "reviewer", packageName: "@acme/reviewer" },
      path: "/eve/v1/session",
      rootPath: "/packages/reviewer",
      sourceId: "subagents/reviewer",
      sourceKind: "subagent",
    });
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          binding: {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/app/agent/extensions/reviewer.ts",
            },
            owner: { kind: "application" },
          },
          logicalPath: "extensions/reviewer.ts",
          sourceId: "extensions/reviewer.ts",
        },
      ],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      extensionMounts: [
        {
          externalDependencies: [],
          mountLogicalPath: "extensions/reviewer.ts",
          mountSourceId: "extensions/reviewer.ts",
          namespace: "reviewer",
          packageName: "@acme/reviewer",
          packageNamespace: "acme-reviewer",
          sourceRoot: "/packages/reviewer",
        },
      ],
      remoteAgents: [remote],
    });
    const malformedBacking = {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: backing.sourcePath,
    };
    const malformed = {
      ...manifest,
      remoteAgents: [
        {
          ...remote,
          bindings: {
            [remote.configResolver.sourceId]: {
              ...remote.bindings[remote.configResolver.sourceId]!,
              backing: malformedBacking,
            },
          },
        },
      ],
    };

    const structural = compiledAgentManifestSchema.safeParse(malformed);
    expect(
      structural.success,
      structural.success ? "" : JSON.stringify(structural.error.issues),
    ).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "subagents/reviewer" has an extension-owned filesystem binding for "subagents/reviewer::config" without an extension scope.',
    );
  });

  it("rejects a remote config binding with a different programmatic semantic revision", () => {
    const backing = {
      kind: "programmatic" as const,
      moduleId: "subagents/reviewer.ts",
      registryId: "test-remote-agents",
      revision: "source-v1",
      semanticRevision: "reviewer-v1",
    };
    const remote = createTestCompiledRemoteAgentNode({
      backing,
      configResolver: {
        logicalPath: "subagents/reviewer.ts",
        sourceId: "subagents/reviewer::config",
        sourceKind: "module",
      },
      description: "Reviews responses.",
      entryPath: "subagents/reviewer.ts",
      logicalPath: "subagents/reviewer",
      name: "reviewer",
      nodeId: "subagents/reviewer",
      owner: { kind: "application" },
      path: "/eve/v1/session",
      rootPath: "/app/agent",
      sourceId: "subagents/reviewer",
      sourceKind: "subagent",
    });
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      remoteAgents: [remote],
    });
    const configBinding = remote.bindings[remote.configResolver.sourceId]!;

    expect(() =>
      parseCompiledAgentManifest({
        ...manifest,
        remoteAgents: [
          {
            ...remote,
            bindings: {
              ...remote.bindings,
              [remote.configResolver.sourceId]: {
                ...configBinding,
                backing: { ...backing, semanticRevision: "reviewer-v2" },
              },
            },
          },
        ],
      }),
    ).toThrow(
      'Compiled remote agent "subagents/reviewer" config binding does not preserve its source backing.',
    );
  });
});
