import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { JustBashSandbox, type JustBashEnvironmentOptions } from "#sandbox/providers/just-bash.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";

const createScratchDirectory = useTemporaryDirectories();

// Values recorded from the provider before it moved to the public provider
// API. Running sessions and shipped artifacts depend on them, so they must
// never change.
const GOLDEN = {
  sessionRoot: "just-bash/sessions/e87bbba07bceb2ae5b77ad77",
  templateKeys: {
    customCommands: "454772e755ab66d06f71e33a",
    defaults: "81d1596e5801b5002c9c98f1",
    noAutoInstall: "c2a20b8d7c53299c7f94cf4b",
    resources: "a6084cbac4e7af6015da73a2",
  },
};

// Built from source text, so the hashed source does not depend on formatting or transpilation.
const execute = new Function('return async () => ({ exitCode: 0, stderr: "", stdout: "hi\\n" })')();
const filesystem = new Function("return (context) => context.defaultFilesystem")();

class ClassCommand {
  readonly name = "class-command";
  async execute() {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

function createProvider(options?: JustBashEnvironmentOptions) {
  const environment = JustBashSandbox.environment(options);
  return createSandboxProviderHarness(
    getSandboxEnvironmentRuntime(environment).implementation,
    undefined,
  );
}

describe("just-bash persisted identities", () => {
  it("derives the same template keys as earlier releases", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-template-keys-");
    const sourceRevision = "golden-source-revision";
    const prepare = async (options: JustBashEnvironmentOptions | undefined, files = {}) =>
      await createProvider(options).prepare({ appRoot, sourceRevision, ...files });

    const keys = {
      customCommands: await prepare({
        customCommands: [{ execute, name: "hello" }, new ClassCommand()],
        filesystem,
      }),
      defaults: await prepare(undefined),
      noAutoInstall: await prepare({ autoInstall: false }),
      resources: await prepare(undefined, {
        resourcesKey: "golden-resources",
        skills: [{ content: "# Weather\n", relativePath: "weather/SKILL.md" }],
        workspace: [{ content: "notes\n", relativePath: "notes.txt" }],
      }),
    };

    expect(keys).toEqual({
      customCommands: { templateKey: GOLDEN.templateKeys.customCommands },
      defaults: { templateKey: GOLDEN.templateKeys.defaults },
      noAutoInstall: { templateKey: GOLDEN.templateKeys.noAutoInstall },
      resources: { templateKey: GOLDEN.templateKeys.resources },
    });
    for (const templateKey of Object.values(GOLDEN.templateKeys)) {
      await access(join(appRoot, "just-bash/templates", templateKey));
    }
  });

  it("records the same session root and state as earlier releases", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-session-state-");
    const provider = createProvider();
    await provider.prepare({ appRoot });

    const { state } = await provider.start({ appRoot, sandboxName: "session_golden" });

    expect(state).toEqual({ rootPath: join(appRoot, GOLDEN.sessionRoot), version: 2 });
  });

  it("opens a template and resumes a session that an earlier release wrote", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-earlier-release-");
    const templateKey = GOLDEN.templateKeys.defaults;
    const templateRoot = join(appRoot, "just-bash/templates", templateKey);
    await mkdir(join(templateRoot, "fs/workspace"), { recursive: true });
    await writeFile(join(templateRoot, "fs/workspace/notes.txt"), "from the template\n");
    await writeFile(
      join(templateRoot, "metadata.json"),
      `${JSON.stringify({ env: { GREETING: "hello" }, version: 1 }, null, 2)}\n`,
    );
    const sessionRoot = join(appRoot, GOLDEN.sessionRoot);
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
