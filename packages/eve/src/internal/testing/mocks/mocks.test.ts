import { describe, expect, it } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";

describe("mockTool", () => {
  it("assigns deterministic defaults from the tool name", () => {
    const tool = mockTool({ name: "get_weather", execute: () => 42 });

    expect(tool.name).toBe("get_weather");
    expect(tool.logicalPath).toBe("tools/get_weather.ts");
    expect(tool.sourceId).toBe("tools/get_weather.ts");
    expect(tool.description).toBe("get_weather mock tool.");
    expect(tool.inputSchema).toBeNull();
    expect(tool.sourceKind).toBe("module");
  });

  it("omits execute when the descriptor does not define one", () => {
    const tool = mockTool({ name: "get_weather" });

    expect(tool.execute).toBeUndefined();
  });

  it("sanitizes characters that are not valid in a logical path", () => {
    const tool = mockTool({ name: "weird name!" });

    expect(tool.logicalPath).toBe("tools/weird-name-.ts");
  });

  it("honours explicit logical path overrides", () => {
    const tool = mockTool({ name: "hello", logicalPath: "custom/tools/hello.ts" });

    expect(tool.logicalPath).toBe("custom/tools/hello.ts");
    expect(tool.sourceId).toBe("custom/tools/hello.ts");
  });
});

describe("mockSandbox", () => {
  it("seeds initial files anchored under /workspace", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "note.txt": "seeded",
        "/workspace/absolute.txt": "absolute",
      },
    });

    expect(sandbox.files.get("/workspace/note.txt")).toBe("seeded");
    expect(sandbox.files.get("/workspace/absolute.txt")).toBe("absolute");
    await expect(sandbox.session.readTextFile({ path: "note.txt" })).resolves.toBe("seeded");
  });

  it("records command invocations in order", async () => {
    const sandbox = mockSandbox();

    await sandbox.session.run({ command: "echo first" });
    await sandbox.session.run({ command: "echo second" });

    expect(sandbox.commandLog).toEqual(["echo first", "echo second"]);
  });

  it("prefers the commands map over the run fallback", async () => {
    const sandbox = mockSandbox({
      commands: {
        "ls -1": { exitCode: 0, stderr: "", stdout: "README.md\n" },
      },
      run: async () => ({ exitCode: 9, stderr: "fallback", stdout: "" }),
    });

    const matched = await sandbox.session.run({ command: "ls -1" });
    const fallback = await sandbox.session.run({ command: "cat README.md" });

    expect(matched.stdout).toBe("README.md\n");
    expect(fallback.stderr).toBe("fallback");
  });

  it("writes UTF-8 payloads and reads them back through the session", async () => {
    const sandbox = mockSandbox();

    await sandbox.session.writeTextFile({ content: "hello", path: "note.txt" });
    await expect(sandbox.session.readTextFile({ path: "note.txt" })).resolves.toBe("hello");
  });

  it("supports line-range reads on stored files", async () => {
    const sandbox = mockSandbox({
      initialFiles: { "multiline.txt": "one\ntwo\nthree\nfour" },
    });

    await expect(
      sandbox.session.readTextFile({ endLine: 3, path: "multiline.txt", startLine: 2 }),
    ).resolves.toBe("two\nthree");
  });

  it("returns null for missing files", async () => {
    const sandbox = mockSandbox();

    await expect(sandbox.session.readTextFile({ path: "missing.txt" })).resolves.toBeNull();
  });

  it("resolves relative paths against /workspace and preserves absolute paths", () => {
    const sandbox = mockSandbox();

    expect(sandbox.session.resolvePath("a/b.txt")).toBe("/workspace/a/b.txt");
    expect(sandbox.session.resolvePath("/tmp/x")).toBe("/tmp/x");
  });
});
