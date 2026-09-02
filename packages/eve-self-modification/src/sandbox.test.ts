import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as justBash from "just-bash";
import { afterEach, describe, expect, it } from "vitest";

import { createSelfModificationFilesystem } from "./filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createAppRoot(options: { traces?: boolean } = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-self-modification-sandbox-"));
  temporaryDirectories.push(appRoot);
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, "node_modules/eve/docs"), { recursive: true });
  if (options.traces !== false) {
    await mkdir(join(appRoot, ".eve/traces/v1/trace-1/segments"), { recursive: true });
    await writeFile(join(appRoot, ".eve/traces/v1/trace-1/segments/span.otlp.json"), "trace\n");
  }
  await writeFile(join(appRoot, "node_modules/eve/docs/README.md"), "installed eve docs\n");
  return appRoot;
}

describe("self-modification filesystem", () => {
  it("mounts authored source read-write and traces and eve docs read-only", async () => {
    const appRoot = await createAppRoot();
    const filesystem = await createSelfModificationFilesystem({
      appRoot,
      defaultFilesystem: new justBash.InMemoryFs(),
      justBash,
    });

    expect(await filesystem.readFile("/traces/trace-1/segments/span.otlp.json")).toBe("trace\n");
    await expect(
      filesystem.writeFile("/traces/trace-1/segments/span.otlp.json", "changed\n"),
    ).rejects.toThrow(/read-only file system/u);

    expect(await filesystem.readFile("/eve-docs/README.md")).toBe("installed eve docs\n");
    await expect(filesystem.writeFile("/eve-docs/README.md", "changed\n")).rejects.toThrow(
      /read-only file system/u,
    );

    await filesystem.writeFile("/source/instructions.md", "authored\n");
    expect(await readFile(join(appRoot, "agent/instructions.md"), "utf8")).toBe("authored\n");
  });

  it("mounts an empty trace directory when no local traces have been captured", async () => {
    const appRoot = await createAppRoot({ traces: false });
    const filesystem = await createSelfModificationFilesystem({
      appRoot,
      defaultFilesystem: new justBash.InMemoryFs(),
      justBash,
    });

    expect(await filesystem.readdir("/traces")).toEqual([]);
  });
});
