import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { JustBashSandbox, type JustBashEnvironmentOptions } from "#sandbox/providers/just-bash.js";

const createScratchDirectory = useTemporaryDirectories();

// Recorded from the provider before it moved to the public provider API.
// Running sessions depend on it, so it must never change.
const GOLDEN_SESSION_ROOT = "just-bash/sessions/e87bbba07bceb2ae5b77ad77";

class QueryCommand {
  readonly name = "query";
  readonly client = new Map([["primary", "db.internal"]]);
  readonly since = new Date(0);
  async execute() {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

function createProvider(options?: JustBashEnvironmentOptions) {
  return createSandboxEnvironmentHarness(JustBashSandbox.environment(options));
}

describe("just-bash persisted identities", () => {
  it("keeps custom commands and the filesystem out of the template key", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-template-keys-");

    const plain = await createProvider().prepare({ appRoot });
    const customized = await createProvider({
      customCommands: [new QueryCommand()],
      filesystem: ({ defaultFilesystem }) => defaultFilesystem,
    }).prepare({ appRoot });

    expect(customized).toEqual(plain);
  });

  it("records the same session root and state as earlier releases", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-session-state-");
    const provider = createProvider();
    await provider.prepare({ appRoot });

    const { state } = await provider.start({ appRoot, sandboxName: "session_golden" });

    expect(state).toEqual({ rootPath: join(appRoot, GOLDEN_SESSION_ROOT), version: 2 });
  });

  it("opens a template and resumes a session that an earlier release wrote", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-earlier-release-");
    const templateKey = "81d1596e5801b5002c9c98f1";
    const templateRoot = join(appRoot, "just-bash/templates", templateKey);
    await mkdir(join(templateRoot, "fs/workspace"), { recursive: true });
    await writeFile(join(templateRoot, "fs/workspace/notes.txt"), "from the template\n");
    await writeFile(
      join(templateRoot, "metadata.json"),
      `${JSON.stringify({ env: { GREETING: "hello" }, version: 1 }, null, 2)}\n`,
    );
    const sessionRoot = join(appRoot, GOLDEN_SESSION_ROOT);
    await mkdir(join(sessionRoot, "fs/workspace"), { recursive: true });
    await writeFile(join(sessionRoot, "fs/workspace/kept.txt"), "kept\n");
    const provider = createProvider();

    const started = await provider.openSession({
      appRoot,
      prepared: { templateKey },
      sandboxName: "session_new",
    });
    await expect(
      started.sandbox.run({ command: 'cat notes.txt && echo "$GREETING"' }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "from the template\nhello\n" });

    const resumed = await provider.openSession({
      appRoot,
      existing: { rootPath: sessionRoot, version: 2 },
      prepared: { templateKey },
      sandboxName: "session_golden",
    });
    await expect(resumed.sandbox.readTextFile({ path: "kept.txt" })).resolves.toBe("kept\n");
  });
});
