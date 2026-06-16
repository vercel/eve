import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";

describe("buildMemoryAgentProject", () => {
  it("assembles nested app/agent roots with a synthetic package.json marker", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a test assistant.",
        "tools/weather.ts": "export default {};",
      },
    });

    expect(project.appRoot).toBe("/memory/app");
    expect(project.agentRoot).toBe("/memory/app/agent");
    await expect(project.source.readTextFile("/memory/app/package.json")).resolves.toContain(
      "memory-agent",
    );
    await expect(project.source.readTextFile("/memory/app/agent/instructions.md")).resolves.toBe(
      "You are a test assistant.",
    );
    await expect(project.source.stat("/memory/app/agent/tools")).resolves.toBe("directory");
  });

  it("materializes flat layouts without an agent/ subdirectory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "",
      },
      flat: true,
    });

    expect(project.agentRoot).toBe(project.appRoot);
    await expect(project.source.stat("/memory/app/instructions.md")).resolves.toBe("file");
  });

  it("registers explicit empty agent directories so listings include them", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["connections"],
      agentFiles: {
        "instructions.md": "",
      },
    });

    await expect(project.source.stat("/memory/app/agent/connections")).resolves.toBe("directory");
    const entries = await project.source.readDirectory("/memory/app/agent");
    expect(entries.some((entry) => entry.name === "connections" && entry.isDirectory())).toBe(true);
  });

  it("allows omitting the auto-authored package.json for 'no agent found' cases", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "README.md": "not an agent",
      },
      omitPackageJson: true,
    });

    await expect(project.source.stat("/memory/app/package.json")).resolves.toBe("missing");
    await expect(project.source.readTextFile("/memory/app/README.md")).resolves.toBe(
      "not an agent",
    );
  });
});
