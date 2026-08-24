import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCompiledModuleMapIdentity } from "#compiler/module-map.js";
import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("compiled module-map identity", () => {
  it("changes when selected source content changes without changing source keys", async () => {
    const appRoot = await createScratchDirectory("eve-module-map-identity-");
    const agentRoot = join(appRoot, "agent");
    await writeFile(join(appRoot, "package.json"), '{"name":"identity-fixture"}\n');
    await mkdir(join(agentRoot, "tools"), { recursive: true });
    const toolPath = join(agentRoot, "tools", "echo.ts");
    await writeFile(toolPath, 'export const implementation = "first";\n');
    const manifest = createStubCompiledAgentManifest({
      agentRoot,
      appRoot,
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          binding: {
            backing: { externalDependencies: [], kind: "filesystem", sourcePath: toolPath },
            owner: { kind: "application" },
          },
          logicalPath: "tools/echo.ts",
          sourceId: "tools/echo.ts",
        },
      ],
      config: {
        model: { id: "openai/gpt-5.4-mini", routing: { kind: "gateway", target: "openai" } },
        name: "identity-fixture",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      tools: [
        {
          description: "Echo.",
          inputSchema: null,
          logicalPath: "tools/echo.ts",
          name: "echo",
          sourceId: "tools/echo.ts",
          sourceKind: "module",
        },
      ],
    });
    const first = await createCompiledModuleMapIdentity(manifest);

    await writeFile(toolPath, 'export const implementation = "second";\n');

    await expect(createCompiledModuleMapIdentity(manifest)).resolves.not.toBe(first);
  });

  it("changes when a selected module's local dependency changes", async () => {
    const appRoot = await createScratchDirectory("eve-module-map-dependency-identity-");
    const agentRoot = join(appRoot, "agent");
    await writeFile(join(appRoot, "package.json"), '{"name":"dependency-identity-fixture"}\n');
    await mkdir(join(agentRoot, "tools"), { recursive: true });
    const dependencyPath = join(agentRoot, "tools", "implementation.ts");
    const toolPath = join(agentRoot, "tools", "echo.ts");
    await Promise.all([
      writeFile(dependencyPath, 'export const implementation = "first";\n'),
      writeFile(toolPath, 'export { implementation } from "./implementation.js";\n'),
    ]);
    const manifest = createStubCompiledAgentManifest({
      agentRoot,
      appRoot,
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        {
          binding: {
            backing: { externalDependencies: [], kind: "filesystem", sourcePath: toolPath },
            owner: { kind: "application" },
          },
          logicalPath: "tools/echo.ts",
          sourceId: "tools/echo.ts",
        },
      ],
      config: {
        model: { id: "openai/gpt-5.4-mini", routing: { kind: "gateway", target: "openai" } },
        name: "dependency-identity-fixture",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
      },
      tools: [
        {
          description: "Echo.",
          inputSchema: null,
          logicalPath: "tools/echo.ts",
          name: "echo",
          sourceId: "tools/echo.ts",
          sourceKind: "module",
        },
      ],
    });
    const first = await createCompiledModuleMapIdentity(manifest);

    await writeFile(dependencyPath, 'export const implementation = "second";\n');

    await expect(createCompiledModuleMapIdentity(manifest)).resolves.not.toBe(first);
  });

  it("is invariant to an extension source graph being relocated into a generation", async () => {
    const appRoot = await createScratchDirectory("eve-module-map-relocation-");
    await writeFile(join(appRoot, "package.json"), '{"name":"relocation-identity-fixture"}\n');
    const agentRoot = join(appRoot, "agent");
    const extensionMountPath = join(agentRoot, "extensions", "crm.ts");
    const sourceRoot = join(appRoot, "packages", "extension");
    const relocatedRoot = join(appRoot, ".eve", "generation", "extension");
    const sourcePath = join(sourceRoot, "tools", "echo.ts");
    const relocatedPath = join(relocatedRoot, "tools", "echo.ts");
    await Promise.all([
      mkdir(join(agentRoot, "extensions"), { recursive: true }),
      mkdir(join(sourceRoot, "tools"), { recursive: true }),
      mkdir(join(relocatedRoot, "tools"), { recursive: true }),
    ]);
    const source = 'export const implementation = "same";\n';
    await Promise.all([
      writeFile(extensionMountPath, 'export default { package: "@acme/crm" };\n'),
      writeFile(sourcePath, source),
      writeFile(relocatedPath, source),
    ]);
    const createManifest = (physicalSourceRoot: string, physicalSourcePath: string) =>
      createStubCompiledAgentManifest({
        agentRoot,
        appRoot,
        bindings: [
          TEST_COMPILED_AGENT_CONFIG_BINDING,
          {
            binding: {
              backing: {
                externalDependencies: [],
                kind: "filesystem",
                sourcePath: extensionMountPath,
              },
              owner: { kind: "application" },
            },
            logicalPath: "extensions/crm.ts",
            sourceId: "extensions/crm.ts",
          },
          {
            binding: {
              backing: {
                externalDependencies: [],
                extensionScope: {
                  namespace: "acme-crm",
                  sourceRoot: physicalSourceRoot,
                },
                kind: "filesystem",
                sourcePath: physicalSourcePath,
              },
              owner: { kind: "extension", namespace: "crm", packageName: "@acme/crm" },
            },
            logicalPath: "tools/echo.ts",
            sourceId: "ext:crm:tools/echo.ts",
          },
        ],
        config: {
          model: { id: "openai/gpt-5.4-mini", routing: { kind: "gateway", target: "openai" } },
          name: "identity-relocation-fixture",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
        extensionMounts: [
          {
            externalDependencies: [],
            mountLogicalPath: "extensions/crm.ts",
            mountSourceId: "extensions/crm.ts",
            namespace: "crm",
            packageName: "@acme/crm",
            packageNamespace: "acme-crm",
            sourceRoot: physicalSourceRoot,
          },
        ],
        tools: [
          {
            description: "Echo.",
            inputSchema: null,
            logicalPath: "tools/echo.ts",
            name: "echo",
            sourceId: "ext:crm:tools/echo.ts",
            sourceKind: "module",
          },
        ],
      });

    await expect(
      createCompiledModuleMapIdentity(createManifest(relocatedRoot, relocatedPath)),
    ).resolves.toBe(await createCompiledModuleMapIdentity(createManifest(sourceRoot, sourcePath)));
  });
});
