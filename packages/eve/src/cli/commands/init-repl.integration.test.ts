import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isCodingAgentReplAvailable } from "./init-repl.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = undefined;
  }
});

describe("isCodingAgentReplAvailable", () => {
  it("finds an executable coding-agent REPL on PATH", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "eve-init-repl-"));
    const executableName = process.platform === "win32" ? "claude.EXE" : "claude";
    const executablePath = join(temporaryDirectory, executableName);
    await writeFile(executablePath, "", "utf8");
    await chmod(executablePath, 0o755);
    vi.stubEnv("PATH", temporaryDirectory);
    if (process.platform === "win32") vi.stubEnv("PATHEXT", ".EXE");

    await expect(isCodingAgentReplAvailable("claude")).resolves.toBe(true);
    await expect(isCodingAgentReplAvailable("codex")).resolves.toBe(false);
  });
});
