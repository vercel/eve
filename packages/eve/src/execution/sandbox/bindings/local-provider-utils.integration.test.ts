import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyDirectoryAtomically } from "#execution/sandbox/bindings/local-provider-utils.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("copyDirectoryAtomically", () => {
  it("keeps relative symlinks inside the copy instead of pointing them back at the template", async () => {
    const root = await createScratchDirectory("eve-sandbox-template-copy-");
    const templatePath = join(root, "template");
    const sessionPath = join(root, "session");
    await mkdir(join(templatePath, "data"), { recursive: true });
    await writeFile(join(templatePath, "data", "notes.txt"), "template");
    await symlink(join("data", "notes.txt"), join(templatePath, "current.txt"));

    await copyDirectoryAtomically(templatePath, sessionPath);
    await writeFile(join(sessionPath, "current.txt"), "session");

    expect(await readFile(join(templatePath, "data", "notes.txt"), "utf8")).toBe("template");
    expect(await readFile(join(sessionPath, "data", "notes.txt"), "utf8")).toBe("session");
    expect(await readlink(join(sessionPath, "current.txt"))).toBe(join("data", "notes.txt"));
  });
});
