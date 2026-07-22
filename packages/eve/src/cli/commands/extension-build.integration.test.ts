import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runExtensionBuildCommand, type ExtensionBuildCliLogger } from "./extension-build.js";

function logger(): ExtensionBuildCliLogger & { messages: string[]; errors: string[] } {
  const messages: string[] = [];
  const errors: string[] = [];
  return {
    messages,
    errors,
    log: (message) => messages.push(message),
    error: (message) => errors.push(message),
  };
}

describe("runExtensionBuildCommand", () => {
  it("rejects a package that is not an extension and points at eve extension build", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-extension-build-agent-"));
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "my-agent", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    const output = logger();

    await expect(runExtensionBuildCommand(output, root)).rejects.toThrow(
      "This package is not an eve extension",
    );
    expect(output.messages).toEqual([]);
  });

  it("builds a valid extension package", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-extension-build-ok-"));
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "@acme/crm",
          type: "module",
          eve: {
            extension: { source: "./extension", dist: "./dist/extension" },
          },
          peerDependencies: { eve: "*" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      dirname(createRequire(import.meta.url).resolve("eve/package.json")),
      join(root, "node_modules", "eve"),
      "dir",
    );
    await mkdir(join(root, "extension"), { recursive: true });
    await writeFile(
      join(root, "extension", "extension.ts"),
      [
        'import { defineExtension } from "eve/extension";',
        "export default defineExtension();",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = logger();
    await runExtensionBuildCommand(output, root);

    const printed = output.messages.join("\n");
    expect(printed).toContain("built extension");
    expect(printed).toContain("@acme/crm");
    expect(printed).toContain(join(root, "dist"));
  });
});
