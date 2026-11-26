import { describe, expect, it, vi } from "vitest";

import { stubSpawnProcess } from "./_helpers/sandbox-session-stub.js";

import { toolModelOutputContext } from "../src/harness/tool-model-output.js";
import type { SandboxSession } from "../src/shared/sandbox-session.js";
import {
  executeWriteFileOnSandbox,
  type WriteFileResult,
} from "../src/execution/sandbox/write-file.js";
import { writeFile } from "../src/tools/provided/write-file.js";

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createFakeSandbox(files: Record<string, string>): {
  files: Record<string, string>;
  readBinaryFile: ReturnType<typeof vi.fn>;
  session: SandboxSession;
} {
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) => {
    const content = files[path];
    return content === undefined ? null : new TextEncoder().encode(content);
  });
  const session = {
    id: "test-write-file-sandbox",
    async readFile() {
      return null;
    },
    readBinaryFile,
    async readTextFile({ path }: { path: string }) {
      const content = files[path];
      return content ?? null;
    },
    async setNetworkPolicy() {},
    async removePath({ path }: { path: string }) {
      delete files[path];
    },
    resolvePath(path: string) {
      return path;
    },
    async run({ command }: { command: string }) {
      if (command === HOME_PROBE_COMMAND) {
        return { exitCode: 0, stderr: "", stdout: "/home/agent\n" };
      }
      const existsMatch = /^test -e '((?:[^']|'\\'')*)'$/.exec(command);
      if (existsMatch !== null) {
        const target = existsMatch[1]!.replaceAll("'\\''", "'");
        return { exitCode: Object.hasOwn(files, target) ? 0 : 1, stderr: "", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async spawn() {
      return stubSpawnProcess();
    },
    async writeFile() {},
    async writeBinaryFile() {},
    async writeFiles() {},
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files[path] = content;
    },
  } as SandboxSession;

  return { files, readBinaryFile, session };
}

describe("executeWriteFileOnSandbox", () => {
  it("creates a new file without reading existing bytes", async () => {
    const { files, readBinaryFile, session } = createFakeSandbox({});

    const result: WriteFileResult = await executeWriteFileOnSandbox(session, {
      filePath: "/workspace/new.ts",
      content: "hello",
    });

    expect(result).toEqual({ existed: false, path: "/workspace/new.ts" });
    expect(files["/workspace/new.ts"]).toBe("hello");
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("overwrites an existing file without a prior read or buffering its contents", async () => {
    const { files, readBinaryFile, session } = createFakeSandbox({
      "/workspace/foo.ts": "original",
    });

    const result: WriteFileResult = await executeWriteFileOnSandbox(session, {
      filePath: "/workspace/foo.ts",
      content: "new content",
    });

    expect(result).toEqual({ existed: true, path: "/workspace/foo.ts" });
    expect(files["/workspace/foo.ts"]).toBe("new content");
    expect(readBinaryFile).not.toHaveBeenCalled();
  });

  it("resolves $HOME and ~/ paths to the sandbox home directory", async () => {
    const filePath = "/home/agent/.agents/skills/research/references/catalog.md";
    const { files, session } = createFakeSandbox({ [filePath]: "original" });

    const first = await executeWriteFileOnSandbox(session, {
      content: "updated-1",
      filePath: "$HOME/.agents/skills/research/references/catalog.md",
    });
    const second = await executeWriteFileOnSandbox(session, {
      content: "updated-2",
      filePath: "~/.agents/skills/research/references/catalog.md",
    });

    expect(first).toEqual({ existed: true, path: filePath });
    expect(second).toEqual({ existed: true, path: filePath });
    expect(files[filePath]).toBe("updated-2");
  });

  it.each(["$HOME/notes.md", "~/notes.md"])(
    "rejects %s when the sandbox has no usable home",
    async (filePath) => {
      const { session } = createFakeSandbox({});
      const noHome: SandboxSession = {
        ...session,
        run: async () => ({ exitCode: 0, stderr: "", stdout: "\n" }),
      };

      await expect(executeWriteFileOnSandbox(noHome, { content: "x", filePath })).rejects.toThrow(
        `Cannot resolve "${filePath}": the sandbox has no usable $HOME.`,
      );
    },
  );
});

describe("writeFile.toModelOutput", () => {
  it("renders standard results as plain text and preserves wrapper extra fields as JSON", async () => {
    expect(
      await writeFile.toModelOutput?.(
        { existed: false, path: "/workspace/a.ts" },
        toolModelOutputContext("write_file", "call_1"),
      ),
    ).toEqual({ type: "text", value: "Wrote /workspace/a.ts." });

    expect(
      await writeFile.toModelOutput?.(
        { existed: true, path: "/workspace/a.ts" },
        toolModelOutputContext("write_file", "call_2"),
      ),
    ).toEqual({ type: "text", value: "Overwrote /workspace/a.ts." });

    const wrapped = { existed: true, extra: 42, path: "/workspace/a.ts" };
    expect(
      await writeFile.toModelOutput?.(
        wrapped as never,
        toolModelOutputContext("write_file", "call_3"),
      ),
    ).toEqual({ type: "json", value: wrapped });
  });
});
