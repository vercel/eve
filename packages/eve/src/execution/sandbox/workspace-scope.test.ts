import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { scopeSandboxSessionToAgentHome } from "#execution/sandbox/workspace-scope.js";

const HOME = "/agents/researcher-1c3a9f42";

function createRecordingSession(): SandboxSession {
  return {
    id: "test-sandbox",
    readBinaryFile: vi.fn(async () => null),
    readFile: vi.fn(async () => null),
    readTextFile: vi.fn(async () => null),
    removePath: vi.fn(async () => {}),
    resolvePath: (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`),
    run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    setNetworkPolicy: vi.fn(async () => {}),
    spawn: vi.fn(async () => {
      throw new Error("spawn is not implemented in this test sandbox");
    }),
    writeBinaryFile: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("scopeSandboxSessionToAgentHome", () => {
  it("returns the session unchanged for the sandbox-owning agent", () => {
    const session = createRecordingSession();
    expect(scopeSandboxSessionToAgentHome(session, undefined)).toBe(session);
  });

  it("keeps relative paths anchored at the shared workspace", async () => {
    const session = createRecordingSession();
    const scoped = scopeSandboxSessionToAgentHome(session, HOME);

    await scoped.readTextFile({ path: "notes.md" });
    expect(session.readTextFile).toHaveBeenCalledWith({ path: "/workspace/notes.md" });

    expect(scoped.resolvePath("notes.md")).toBe("/workspace/notes.md");
  });

  it("resolves $HOME paths into the agent home", async () => {
    const session = createRecordingSession();
    const scoped = scopeSandboxSessionToAgentHome(session, HOME);

    expect(scoped.resolvePath("$HOME")).toBe(HOME);
    expect(scoped.resolvePath("$HOME/.agents/skills")).toBe(`${HOME}/.agents/skills`);

    await scoped.readTextFile({ path: "$HOME/.agents/skills/research/SKILL.md" });
    expect(session.readTextFile).toHaveBeenCalledWith({
      path: `${HOME}/.agents/skills/research/SKILL.md`,
    });
  });

  it("exports HOME on run and spawn without changing the working directory", async () => {
    const session = createRecordingSession();
    const scoped = scopeSandboxSessionToAgentHome(session, HOME);

    await scoped.run({ command: "pwd" });
    expect(session.run).toHaveBeenCalledWith({ command: "pwd", env: { HOME } });
  });

  it("keeps caller-provided env vars while exporting HOME", async () => {
    const session = createRecordingSession();
    const scoped = scopeSandboxSessionToAgentHome(session, HOME);

    await scoped.run({ command: "env", env: { FOO: "bar" } });
    expect(session.run).toHaveBeenCalledWith({ command: "env", env: { FOO: "bar", HOME } });
  });

  it("passes explicit absolute paths and working directories through untouched", async () => {
    const session = createRecordingSession();
    const scoped = scopeSandboxSessionToAgentHome(session, HOME);

    await scoped.readTextFile({ path: "/workspace/shared.txt" });
    expect(session.readTextFile).toHaveBeenCalledWith({ path: "/workspace/shared.txt" });

    await scoped.run({ command: "ls", workingDirectory: "/tmp" });
    expect(session.run).toHaveBeenCalledWith({
      command: "ls",
      env: { HOME },
      workingDirectory: "/tmp",
    });
  });
});
