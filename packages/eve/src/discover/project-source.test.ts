import { describe, expect, it } from "vitest";

import { createMemoryProjectSource } from "#discover/project-source.js";

describe("createMemoryProjectSource", () => {
  it("classifies registered files and inferred directories", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/app/agent/instructions.md": "# hello",
        "/app/agent/tools/weather.ts": "export default {};",
      },
    });

    await expect(source.stat("/app/agent/instructions.md")).resolves.toBe("file");
    await expect(source.stat("/app/agent/tools")).resolves.toBe("directory");
    await expect(source.stat("/app/agent/tools/weather.ts")).resolves.toBe("file");
    await expect(source.stat("/app")).resolves.toBe("directory");
    await expect(source.stat("/missing")).resolves.toBe("missing");
  });

  it("returns entries with working isDirectory / isFile predicates", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/app/agent/agent.ts": "export default {};",
        "/app/agent/tools/a.ts": "",
        "/app/agent/tools/b.ts": "",
      },
    });

    const entries = await source.readDirectory("/app/agent");
    const byName = new Map(entries.map((entry) => [entry.name, entry] as const));
    const agentEntry = byName.get("agent.ts");
    const toolsEntry = byName.get("tools");

    expect(agentEntry?.isFile()).toBe(true);
    expect(agentEntry?.isDirectory()).toBe(false);
    expect(toolsEntry?.isDirectory()).toBe(true);
    expect(toolsEntry?.isFile()).toBe(false);
  });

  it("reads UTF-8 file contents by absolute path", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/app/package.json": '{ "name": "memory-app" }',
      },
    });

    await expect(source.readTextFile("/app/package.json")).resolves.toBe(
      '{ "name": "memory-app" }',
    );
  });

  it("accepts both string and {content} values", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/a.md": "direct",
        "/b.md": { content: "wrapped" },
      },
    });

    await expect(source.readTextFile("/a.md")).resolves.toBe("direct");
    await expect(source.readTextFile("/b.md")).resolves.toBe("wrapped");
  });

  it("throws a descriptive error when reading a missing file", async () => {
    const source = createMemoryProjectSource({
      rootDir: "/app",
      files: {
        "/app/a.md": "",
      },
    });

    await expect(source.readTextFile("/app/missing.md")).rejects.toThrow(/does not exist/);
  });

  it("throws a descriptive error when listing a missing directory", async () => {
    const source = createMemoryProjectSource({
      files: {
        "/app/a.md": "",
      },
    });

    await expect(source.readDirectory("/app/missing")).rejects.toThrow(/does not exist/);
  });

  it("registers explicit empty directories so they appear in parent listings", async () => {
    const source = createMemoryProjectSource({
      directories: ["/app/agent/connections"],
      files: {
        "/app/agent/instructions.md": "",
      },
    });

    await expect(source.stat("/app/agent/connections")).resolves.toBe("directory");
    await expect(source.readDirectory("/app/agent/connections")).resolves.toEqual([]);

    const agentEntries = await source.readDirectory("/app/agent");
    const connectionsEntry = agentEntries.find((entry) => entry.name === "connections");

    expect(connectionsEntry?.isDirectory()).toBe(true);
  });
});
