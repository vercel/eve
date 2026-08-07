import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it } from "vitest";

import { createSelfmodFilesystem } from "./sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-selfmod-sandbox-"));
  temporaryDirectories.push(appRoot);
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, "node_modules/eve/docs"), { recursive: true });
  await writeFile(join(appRoot, "node_modules/eve/docs/README.md"), "installed eve docs\n");
  return appRoot;
}

describe("selfmod filesystem", () => {
  it("mounts authored source read-write and installed eve docs read-only", async () => {
    const appRoot = await createAppRoot();
    const filesystem = await createSelfmodFilesystem({
      appRoot,
      defaultFilesystem: new InMemoryFs(),
    });

    expect(await filesystem.readFile("/eve-docs/README.md")).toBe("installed eve docs\n");
    await expect(filesystem.writeFile("/eve-docs/README.md", "changed\n")).rejects.toThrow(
      /read-only file system/u,
    );

    await filesystem.writeFile("/source/instructions.md", "authored\n");
    expect(await readFile(join(appRoot, "agent/instructions.md"), "utf8")).toBe("authored\n");
  });
});
