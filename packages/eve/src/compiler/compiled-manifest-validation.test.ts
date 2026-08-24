import { describe, expect, it } from "vitest";

import { parseCompiledAgentManifest } from "#compiler/compiled-manifest-validation.js";
import { compiledAgentManifestSchema, createCompiledAgentManifest } from "#compiler/manifest.js";
import type {
  AgentSourceComposition,
  AgentSourceDescriptor,
} from "#compiler/source-composition.js";
import {
  createStubCompiledAgentManifest,
  createStubCompiledAgentNodeManifest,
  createTestCompiledRemoteAgentNode,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

function createManifestWithChild(
  input: {
    readonly childDynamicSkill?: boolean;
    readonly childSkill?: boolean;
    readonly extensionOwned?: boolean;
    readonly toolName?: string;
  } = {},
) {
  const dynamicSkill = input.childDynamicSkill
    ? {
        eventNames: ["session.started"],
        logicalPath: "skills/runtime.ts",
        slug: "runtime",
        sourceId: "skill:runtime",
        sourceKind: "module" as const,
      }
    : undefined;
  const skill = input.childSkill
    ? {
        description: "Research skill.",
        logicalPath: "skills/research/SKILL.md",
        markdown: "# Research",
        name: "research",
        sourceId: "skill:research",
        sourceKind: "markdown" as const,
      }
    : undefined;
  const child = createStubCompiledAgentNodeManifest(
    {
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        ...(dynamicSkill === undefined
          ? []
          : [{ logicalPath: dynamicSkill.logicalPath, sourceId: dynamicSkill.sourceId }]),
      ],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "research",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      dynamicSkills: dynamicSkill === undefined ? [] : [dynamicSkill],
      skills: skill === undefined ? [] : [skill],
    },
    { isRoot: false, nodeId: "research" },
  );
  const owner = input.extensionOwned
    ? ({ kind: "extension", namespace: "research", packageName: "@acme/research" } as const)
    : ({ kind: "application" } as const);
  const backing = {
    externalDependencies: [],
    ...(input.extensionOwned
      ? { extensionScope: { namespace: "acme-research", sourceRoot: "/packages/research/agent" } }
      : {}),
    kind: "filesystem" as const,
    sourcePath: input.extensionOwned
      ? "/packages/research/agent/agent.ts"
      : "/app/agent/subagents/research/agent.ts",
  };
  const subagent = {
    agent: child,
    backing,
    description: "Researches requests.",
    entryPath: backing.sourcePath,
    logicalPath: "subagents/research",
    name: "research",
    nodeId: "research",
    owner,
    rootPath: input.extensionOwned ? "/packages/research/agent" : "/app/agent/subagents/research",
    sourceId: "research",
    sourceKind: "subagent" as const,
  };
  const tool =
    input.toolName === undefined
      ? undefined
      : {
          description: "Runs a root capability.",
          inputSchema: null,
          logicalPath: `tools/${input.toolName}.ts`,
          name: input.toolName,
          sourceId: `tool:${input.toolName}`,
          sourceKind: "module" as const,
        };
  return createStubCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: [
      TEST_COMPILED_AGENT_CONFIG_BINDING,
      ...(input.extensionOwned
        ? [
            {
              binding: {
                backing: {
                  externalDependencies: [],
                  kind: "filesystem" as const,
                  sourcePath: "/app/agent/extensions/research.ts",
                },
                owner: { kind: "application" as const },
              },
              logicalPath: "extensions/research.ts",
              sourceId: "extensions/research.ts",
            },
          ]
        : []),
      ...(tool === undefined ? [] : [{ logicalPath: tool.logicalPath, sourceId: tool.sourceId }]),
    ],
    config: {
      model: {
        id: "openai/gpt-5.5",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "root",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    extensionMounts: input.extensionOwned
      ? [
          {
            externalDependencies: [],
            mountLogicalPath: "extensions/research.ts",
            mountSourceId: "extensions/research.ts",
            namespace: "research",
            packageName: "@acme/research",
            packageNamespace: "acme-research",
            sourceRoot: "/packages/research/agent",
          },
        ]
      : [],
    subagentEdges: [{ childNodeId: subagent.nodeId, parentNodeId: "__root__" }],
    subagents: [subagent],
    tools: tool === undefined ? [] : [tool],
  });
}

function createManifestWithWorkspace(contentHash: string | null = "0".repeat(64)) {
  return createStubCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
    config: {
      model: {
        id: "openai/gpt-5.5",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "validation",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    sandboxWorkspaces: [
      {
        logicalPath: "sandbox/workspace",
        rootEntries: ["prompts/", "seed.txt"],
        sourceId: "sandbox/workspace",
        sourcePath: "/app/agent/sandbox/workspace",
      },
    ],
    workspaceResourceRoot: {
      contentHash: contentHash ?? undefined,
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["prompts/", "seed.txt"],
    },
  });
}

function createManifestWithRemoteAgent() {
  const backing = {
    kind: "programmatic" as const,
    moduleId: "subagents/reviewer.ts",
    registryId: "test-remote-agents",
    revision: "source-v1",
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
    url: "https://remote.example.com",
  });
  return createStubCompiledAgentManifest({
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
}

describe("parseCompiledAgentManifest", () => {
  it("rejects a loaded manifest with a tool and direct subagent runtime-name collision", () => {
    const manifest = createManifestWithChild({ toolName: "search" });
    const malformed = {
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, name: "research" })),
    };

    expect(() => parseCompiledAgentManifest(malformed)).toThrow(/runtime capability name/u);
  });

  it("rejects an empty static remote subagent url at construction and serialized load", () => {
    const manifest = createManifestWithRemoteAgent();
    const remote = manifest.remoteAgents[0]!;
    const malformed = {
      ...manifest,
      remoteAgents: [{ ...remote, url: "" }],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(false);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled remote agent "subagents/reviewer" has an empty static url.',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      /Too small: expected string to have >=1 characters/u,
    );
  });

  it("rejects root sandbox inheritance at construction and serialized load", () => {
    const manifest = createManifestWithChild();
    const malformed = {
      ...manifest,
      sandbox: { ...manifest.sandbox, inheritsParent: true as const },
    };

    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'selects parent.sandbox but agent node "__root__" has no parent',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(/has no parent/u);
  });

  it("rejects inherited sandboxes with dynamic skills before module hydration", () => {
    const manifest = createManifestWithChild({ childDynamicSkill: true });
    const subagent = manifest.subagents[0];
    if (subagent === undefined || subagent.configResolver !== undefined) {
      throw new Error("Expected one static compiled child.");
    }
    const malformed = {
      ...manifest,
      subagents: [
        {
          ...subagent,
          agent: {
            ...subagent.agent,
            sandbox: { ...subagent.agent.sandbox, inheritsParent: true as const },
          },
        },
      ],
    };

    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      /selects parent\.sandbox but agent node "research" defines dynamic skills/u,
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(/defines dynamic skills/u);
  });

  it("rejects inherited sandboxes with managed workspace resources before module hydration", () => {
    const manifest = createManifestWithChild({ childSkill: true });
    const subagent = manifest.subagents[0];
    if (subagent === undefined || subagent.configResolver !== undefined) {
      throw new Error("Expected one static compiled child.");
    }
    const malformed = {
      ...manifest,
      subagents: [
        {
          ...subagent,
          agent: {
            ...subagent.agent,
            sandbox: { ...subagent.agent.sandbox, inheritsParent: true as const },
          },
        },
      ],
    };

    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      /selects parent\.sandbox but has managed workspace resources/u,
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(/managed workspace resources/u);
  });

  it("rejects structurally valid manifests with invalid binding semantics", () => {
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
    });
    const malformed = {
      ...manifest,
      bindings: {
        ...manifest.bindings,
        unreferenced: {
          backing: {
            externalDependencies: [],
            kind: "filesystem" as const,
            sourcePath: "/app/agent/unreferenced.ts",
          },
          logicalPath: "unreferenced.ts",
          owner: { kind: "application" as const },
        },
      },
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" has an unreferenced binding for "unreferenced".',
    );
  });

  it("rejects a selected module binding without a compiled resource projection", () => {
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
    });
    const malformed = {
      ...manifest,
      bindings: {
        ...manifest.bindings,
        ghost: {
          backing: {
            kind: "programmatic" as const,
            moduleId: "tools/ghost.ts",
            registryId: "test",
            revision: "test-v1",
          },
          logicalPath: "tools/ghost.ts",
          owner: { kind: "application" as const },
        },
      },
      sourceComposition: {
        ...manifest.sourceComposition,
        selected: [
          ...manifest.sourceComposition.selected,
          { slot: "tools/ghost", sourceId: "ghost", sourceKind: "module" as const },
        ],
      },
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" selects module source "ghost" without a compiled resource reference.',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" selects module source "ghost" without a compiled resource reference.',
    );
  });

  it("rejects conflicting named-export projections for static instructions", () => {
    const source = {
      exportName: "namedInstructions",
      logicalPath: "instructions/context.ts",
      sourceId: "named-instructions",
      sourceKind: "module" as const,
    };
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: source.logicalPath, sourceId: source.sourceId },
      ],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      instructions: [
        {
          ...source,
          content: "Exact instructions.",
          name: "instructions/context",
          role: "system",
        },
      ],
    });
    const malformed = {
      ...manifest,
      instructions: [
        ...manifest.instructions,
        { ...manifest.instructions[0]!, exportName: "alternateInstructions" },
      ],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" references source id "named-instructions" with conflicting module projections "instructions/context.ts#namedInstructions" and "instructions/context.ts#alternateInstructions".',
    );
  });

  it("rejects conflicting named-export projections for static schedules", () => {
    const source = {
      exportName: "namedSchedule",
      logicalPath: "schedules/digest.ts",
      sourceId: "named-schedule",
      sourceKind: "module" as const,
    };
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: source.logicalPath, sourceId: source.sourceId },
      ],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      schedules: [
        {
          ...source,
          cron: "0 9 * * *",
          hasRun: true,
          name: "digest",
        },
      ],
    });
    const malformed = {
      ...manifest,
      schedules: [
        ...manifest.schedules,
        { ...manifest.schedules[0]!, exportName: "alternateSchedule" },
      ],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" references source id "named-schedule" with conflicting module projections "schedules/digest.ts#namedSchedule" and "schedules/digest.ts#alternateSchedule".',
    );
  });

  it.each([
    {
      field: "workflowTool",
      malformedPath: "tools/not-workflow.ts",
      selectedPath: "tools/workflow.ts",
      sourceId: "named-workflow",
    },
    {
      field: "webSearchProvider",
      malformedPath: "tools/not-web-search.ts",
      selectedPath: "tools/web_search.ts",
      sourceId: "named-web-search",
    },
  ] as const)("rejects a $field source projection that disagrees with its binding", (input) => {
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      webSearchProvider: {
        exportName: "namedWebSearch",
        logicalPath: "tools/web_search.ts",
        provider: "parallel",
        sourceId: "named-web-search",
        sourceKind: "module",
      },
      workflowTool: {
        exportName: "namedWorkflow",
        logicalPath: "tools/workflow.ts",
        maxSubagents: 7,
        sourceId: "named-workflow",
        sourceKind: "module",
      },
    });
    const definition = manifest[input.field];
    if (definition === undefined) throw new Error(`Missing ${input.field} test definition.`);
    const malformed = {
      ...manifest,
      [input.field]: { ...definition, logicalPath: input.malformedPath },
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      `Compiled node "__root__" binds "${input.sourceId}" to "${input.selectedPath}", but its manifest references "${input.malformedPath}".`,
    );
  });

  it.each(["selected", "disabled", "shadowed"] as const)(
    "rejects impossible %s descriptor layer and owner provenance",
    (state) => {
      const manifest = createStubCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "validation",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      });
      const invalidNonModule = {
        layer: "extension-package",
        logicalPath: "skills/impossible",
        owner: { kind: "application" },
        sourceId: `impossible-${state}`,
        sourceKind: "skill-package",
      } satisfies AgentSourceDescriptor;
      const invalidModule = {
        backing: {
          kind: "programmatic",
          moduleId: "tools/impossible.ts",
          registryId: "test",
          revision: "test-v1",
        },
        layer: "extension-package",
        logicalPath: "tools/impossible.ts",
        owner: { kind: "application" },
        sourceId: `impossible-${state}`,
        sourceKind: "module",
      } satisfies AgentSourceDescriptor;
      const sourceComposition: AgentSourceComposition = {
        ...manifest.sourceComposition,
        disabled:
          state === "disabled"
            ? [
                ...manifest.sourceComposition.disabled,
                { slot: "tools/impossible", source: invalidModule },
              ]
            : manifest.sourceComposition.disabled,
        selected:
          state === "selected"
            ? [
                ...manifest.sourceComposition.selected,
                {
                  slot: "skills/impossible",
                  source: invalidNonModule,
                  sourceKind: "non-module" as const,
                },
              ]
            : manifest.sourceComposition.selected,
        shadowed:
          state === "shadowed"
            ? [
                ...manifest.sourceComposition.shadowed,
                {
                  slot: "agent",
                  source: invalidModule,
                  winningSourceId: manifest.config.source.sourceId,
                },
              ]
            : manifest.sourceComposition.shadowed,
      };
      const malformed = { ...manifest, sourceComposition };

      expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
      expect(() => createCompiledAgentManifest(malformed)).toThrow(
        `Compiled node "__root__" source "impossible-${state}" records layer "extension-package" with owner kind "application" instead of "extension".`,
      );
      expect(() => parseCompiledAgentManifest(malformed)).toThrow(
        `Compiled node "__root__" source "impossible-${state}" records layer "extension-package" with owner kind "application" instead of "extension".`,
      );
    },
  );

  it.each(["channels/child", "instrumentation", "schedules/child"])(
    "rejects root-only child source slot %s",
    (slot) => {
      const manifest = createManifestWithChild();
      const child = manifest.subagents[0]!;
      if (child.configResolver !== undefined) throw new Error("Expected a static test child.");
      const sourceId = `child:${slot}`;
      const malformed = {
        ...manifest,
        subagents: [
          {
            ...child,
            agent: {
              ...child.agent,
              bindings: {
                ...child.agent.bindings,
                [sourceId]: {
                  backing: {
                    kind: "programmatic" as const,
                    moduleId: `${slot}.ts`,
                    registryId: "test",
                    revision: "test-v1",
                  },
                  logicalPath: `${slot}.ts`,
                  owner: { kind: "application" as const },
                },
              },
              sourceComposition: {
                ...child.agent.sourceComposition,
                selected: [
                  ...child.agent.sourceComposition.selected,
                  { slot, sourceId, sourceKind: "module" as const },
                ],
              },
            },
          },
        ],
      };

      expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
      expect(() => createCompiledAgentManifest(malformed)).toThrow(
        `Compiled child node "research" retains root-only source slot "${slot}".`,
      );
      expect(() => parseCompiledAgentManifest(malformed)).toThrow(
        `Compiled child node "research" retains root-only source slot "${slot}".`,
      );
    },
  );

  it("rejects a child instrumentation plan even without retained source composition", () => {
    const manifest = createManifestWithChild();
    const child = manifest.subagents[0]!;
    const malformed = {
      ...manifest,
      subagents: [
        {
          ...child,
          agent: {
            ...child.agent,
            instrumentation: {
              entry: {
                activation: "always" as const,
                implementation: "config" as const,
                source: {
                  logicalPath: "instrumentation.ts",
                  sourceId: "child-instrumentation",
                  sourceKind: "module" as const,
                },
              },
              kind: "file" as const,
            },
          },
        },
      ],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled child node "research" retains a root-only instrumentation plan.',
    );
  });

  it("rejects extension-owned child backing without its extension scope", () => {
    const manifest = createManifestWithChild({ extensionOwned: true });
    const child = manifest.subagents[0]!;
    if (child.backing.kind !== "filesystem") throw new Error("Expected filesystem backing.");
    const malformedBacking = {
      externalDependencies: child.backing.externalDependencies,
      kind: child.backing.kind,
      sourcePath: child.backing.sourcePath,
    };
    const malformed = {
      ...manifest,
      sourceComposition: {
        ...manifest.sourceComposition,
        selected: manifest.sourceComposition.selected.map((selected) =>
          selected.sourceKind === "non-module" && selected.source.sourceId === child.sourceId
            ? { ...selected, source: { ...selected.source, backing: malformedBacking } }
            : selected,
        ),
      },
      subagents: [{ ...child, backing: malformedBacking }],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" has an extension-owned filesystem binding for "research" without an extension scope.',
    );
  });

  it("rejects extension-owned sources without their exact mounted package authority", () => {
    const manifest = createManifestWithChild({ extensionOwned: true });
    const malformed = {
      ...manifest,
      extensionMounts: manifest.extensionMounts.map((mount) => ({
        ...mount,
        packageName: "@acme/impostor",
        packageNamespace: "acme-impostor",
      })),
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" extension-owned source "research" does not descend from an exact mounted package authority.',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" extension-owned source "research" does not descend from an exact mounted package authority.',
    );
  });

  it("rejects an extension mount that self-authorizes its declaration", () => {
    const manifest = createManifestWithChild({ extensionOwned: true });
    const mount = manifest.extensionMounts[0]!;
    const malformed = {
      ...manifest,
      bindings: {
        ...manifest.bindings,
        [mount.mountSourceId]: {
          backing: {
            externalDependencies: [],
            extensionScope: {
              namespace: mount.packageNamespace,
              sourceRoot: mount.sourceRoot,
            },
            kind: "filesystem" as const,
            sourcePath: `${mount.sourceRoot}/extensions/research.ts`,
          },
          logicalPath: mount.mountLogicalPath,
          owner: {
            kind: "extension" as const,
            namespace: mount.namespace,
            packageName: mount.packageName,
          },
        },
      },
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" extension-owned source "extensions/research.ts" does not descend from an exact mounted package authority.',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" extension-owned source "extensions/research.ts" does not descend from an exact mounted package authority.',
    );
  });

  it("rejects a subagent entry path that differs from its filesystem backing", () => {
    const manifest = createManifestWithChild();
    const child = manifest.subagents[0]!;
    const malformed = {
      ...manifest,
      subagents: [{ ...child, entryPath: "/app/agent/subagents/impostor/agent.ts" }],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled subagent "research" entry path does not match its filesystem backing path.',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled subagent "research" entry path does not match its filesystem backing path.',
    );
  });

  it("rejects a subagent entry path outside its physical root", () => {
    const manifest = createManifestWithChild();
    const child = manifest.subagents[0]!;
    const malformed = {
      ...manifest,
      subagents: [{ ...child, rootPath: "/app/agent/subagents/elsewhere" }],
    };

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => createCompiledAgentManifest(malformed)).toThrow(
      'Compiled subagent "research" entry path is outside its physical root "/app/agent/subagents/elsewhere".',
    );
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled subagent "research" entry path is outside its physical root "/app/agent/subagents/elsewhere".',
    );
  });

  it("rejects a non-canonical workspace resource path during construction and load", () => {
    expect(() =>
      createStubCompiledAgentManifest({
        agentRoot: "/app/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.5",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "validation",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        workspaceResourceRoot: {
          logicalPath: "../outside",
          rootEntries: [],
        },
      }),
    ).toThrow(/does not match canonical path/u);

    const manifest = createManifestWithWorkspace();
    const malformed = {
      ...manifest,
      workspaceResourceRoot: {
        ...manifest.workspaceResourceRoot,
        logicalPath: "workspace-resources/subagents/impostor",
      },
    };
    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(/does not match canonical path/u);
  });

  it("rejects non-canonical workspace root entries", () => {
    const manifest = createManifestWithWorkspace();
    const unsorted = {
      ...manifest,
      workspaceResourceRoot: {
        ...manifest.workspaceResourceRoot,
        rootEntries: ["seed.txt", "prompts/"],
      },
    };
    expect(() => parseCompiledAgentManifest(unsorted)).toThrow(
      /not unique and canonically sorted/u,
    );

    const unsafe = {
      ...manifest,
      sandboxWorkspaces: manifest.sandboxWorkspaces.map((workspace) => ({
        ...workspace,
        rootEntries: ["../secret"],
      })),
      workspaceResourceRoot: {
        ...manifest.workspaceResourceRoot,
        rootEntries: ["../secret"],
      },
    };
    expect(() => parseCompiledAgentManifest(unsafe)).toThrow(
      'Compiled node "__root__" has invalid workspace root entry "../secret".',
    );
  });

  it("rejects workspace descriptors that do not project their compiled sources", () => {
    const manifest = createManifestWithWorkspace();
    const malformed = {
      ...manifest,
      workspaceResourceRoot: {
        ...manifest.workspaceResourceRoot,
        rootEntries: ["other.txt"],
      },
    };

    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" workspace resource entries do not match its compiled workspace sources.',
    );
  });

  it("rejects managed workspace resources without a content identity", () => {
    const malformed = createManifestWithWorkspace(null);

    expect(compiledAgentManifestSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseCompiledAgentManifest(malformed)).toThrow(
      'Compiled node "__root__" has managed workspace resources but no compiled contentHash.',
    );
  });

  it("rejects static skill resources without a content identity", () => {
    const manifest = createStubCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: "openai/gpt-5.5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "validation",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      skills: [
        {
          description: "Skill resource",
          logicalPath: "skills/resource.md",
          markdown: "# Resource\n",
          name: "resource",
          sourceId: "skill-resource",
          sourceKind: "markdown",
        },
      ],
    });

    expect(manifest.workspaceResourceRoot.rootEntries).toEqual([]);
    expect(compiledAgentManifestSchema.safeParse(manifest).success).toBe(true);
    expect(() => parseCompiledAgentManifest(manifest)).toThrow(
      'Compiled node "__root__" has managed workspace resources but no compiled contentHash.',
    );
  });
});
