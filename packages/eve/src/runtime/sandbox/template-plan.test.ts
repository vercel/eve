import { describe, expect, it } from "vitest";

import { defineSandbox } from "#public/definitions/sandbox.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";

function definition(environment: SandboxEnvironment): ResolvedSandboxDefinition {
  return {
    environment,
    kind: "independent",
    logicalPath: "sandbox/sandbox.ts",
    revisionHash: "sandbox-revision",
    selector: defineSandbox(() => environment.open()),
    sourceId: "sandbox/sandbox.ts",
    sourceKind: "module",
  };
}

const emptyResources = { logicalPath: "", rootEntries: [] } as const;

describe("createRuntimeSandboxTemplatePlan", () => {
  it("prepares an image environment when it has an authored preparation callback", () => {
    const environment = DockerSandbox.image("node:24", { prepare: async () => {} });

    expect(
      createRuntimeSandboxTemplatePlan({
        definition: definition(environment),
        workspaceResourceRoot: emptyResources,
      }),
    ).toEqual({ revisionHash: "sandbox-revision" });
  });

  it("prepares an image environment even without authored setup", () => {
    const environment = DockerSandbox.image("node:24");

    expect(
      createRuntimeSandboxTemplatePlan({
        definition: definition(environment),
        workspaceResourceRoot: emptyResources,
      }),
    ).toEqual({ contentHash: undefined, revisionHash: "sandbox-revision" });
  });

  it("always prepares a Dockerfile environment", () => {
    const environment = DockerSandbox.dockerfile();

    expect(
      createRuntimeSandboxTemplatePlan({
        definition: definition(environment),
        workspaceResourceRoot: emptyResources,
      }),
    ).toEqual({ revisionHash: "sandbox-revision" });
  });

  it("prepares managed resources independently of provider kind", () => {
    const environment = DockerSandbox.image("node:24");

    expect(
      createRuntimeSandboxTemplatePlan({
        definition: definition(environment),
        workspaceResourceRoot: {
          contentHash: "resource-content",
          logicalPath: "workspace-resources/__root__",
          rootEntries: ["README.md"],
        },
      }),
    ).toEqual({
      contentHash: "resource-content",
      revisionHash: "sandbox-revision",
    });
  });
});
