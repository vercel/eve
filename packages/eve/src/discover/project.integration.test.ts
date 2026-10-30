import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { createMemoryProjectSource } from "#discover/project-source.js";
import { DiscoveryProjectResolutionError, resolveDiscoveryProject } from "#discover/project.js";

describe("resolveDiscoveryProject (memory)", () => {
  it.each([
    { appRoot: "/memory/app/agent", layout: "nested" },
    { appRoot: "/memory/app/agent", layout: "flat" },
    { appRoot: "/memory/app/src/agent", layout: "nested" },
    { appRoot: "/memory/app/src/agent", layout: "flat" },
  ] as const)(
    "resolves the $layout project at $appRoot using its own manifest",
    async ({ appRoot, layout }) => {
      const agentRoot = layout === "nested" ? join(appRoot, "agent") : appRoot;
      const instructionsPath = join(agentRoot, "instructions.md");
      const manifest = JSON.stringify({ dependencies: { eve: "*" } });
      const source = createMemoryProjectSource({
        files: {
          "/memory/app/package.json": manifest,
          [join(appRoot, "package.json")]: manifest,
          [instructionsPath]: "You are a weather assistant.",
        },
      });

      for (const startPath of [appRoot, instructionsPath]) {
        await expect(resolveDiscoveryProject(startPath, { source })).resolves.toEqual({
          agentRoot: resolve(agentRoot),
          appRoot: resolve(appRoot),
          layout,
        });
      }
    },
  );

  it("resolves a nested app root and agent root from the app root", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
      },
      packageName: "weather-agent",
    });

    await expect(
      resolveDiscoveryProject(project.appRoot, {
        source: project.source,
      }),
    ).resolves.toEqual({
      agentRoot: resolve(project.agentRoot),
      appRoot: resolve(project.appRoot),
      layout: "nested",
    });
  });

  it("resolves a nested app root when starting from inside the agent tree", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["context"],
      packageName: "weather-agent",
    });

    await expect(
      resolveDiscoveryProject(join(project.agentRoot, "context"), {
        source: project.source,
      }),
    ).resolves.toEqual({
      agentRoot: resolve(project.agentRoot),
      appRoot: resolve(project.appRoot),
      layout: "nested",
    });
  });

  it("resolves a flat agent root when the project root itself owns the agent files", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a weather assistant.",
      },
      flat: true,
      packageName: "weather-agent",
    });

    await expect(
      resolveDiscoveryProject(project.appRoot, {
        source: project.source,
      }),
    ).resolves.toEqual({
      agentRoot: resolve(project.appRoot),
      appRoot: resolve(project.appRoot),
      layout: "flat",
    });
  });

  it("raises a structured resolution error when no eve agent root can be found", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "README.md": "not an agent",
      },
      omitPackageJson: true,
    });

    await expect(
      resolveDiscoveryProject(project.appRoot, { source: project.source }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: "discover/project-not-found",
        severity: "error",
        sourcePath: resolve(project.appRoot),
      },
    });
    await expect(
      resolveDiscoveryProject(project.appRoot, { source: project.source }),
    ).rejects.toBeInstanceOf(DiscoveryProjectResolutionError);
  });

  it("does not treat a standalone lib directory as a flat agent root", async () => {
    const project = buildMemoryAgentProject({
      appDirectories: ["lib"],
      packageName: "not-an-agent",
    });

    await expect(
      resolveDiscoveryProject(project.appRoot, { source: project.source }),
    ).rejects.toBeInstanceOf(DiscoveryProjectResolutionError);
  });
});
