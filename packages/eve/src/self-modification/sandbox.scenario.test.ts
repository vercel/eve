import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as justBash from "just-bash";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalDevCapabilityEnvironment } from "#runtime/local-dev-capability.js";

import { createLocalSelfModificationFilesystem } from "./filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function withLocalDevCapability<T>(appRoot: string, callback: () => Promise<T>): Promise<T> {
  const restore = installLocalDevCapabilityEnvironment({
    appRoot,
    serverUrl: "http://127.0.0.1:3000",
  });
  try {
    return await callback();
  } finally {
    restore();
  }
}

async function createAppRoot(options: { traces?: boolean; logs?: boolean } = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-self-modification-sandbox-"));
  temporaryDirectories.push(appRoot);
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, "node_modules/eve/docs"), { recursive: true });
  if (options.traces !== false) {
    await mkdir(join(appRoot, ".eve/traces/v1/trace-1/segments"), { recursive: true });
    await writeFile(join(appRoot, ".eve/traces/v1/trace-1/segments/span.otlp.json"), "trace\n");
  }
  if (options.logs !== false) {
    await mkdir(join(appRoot, ".eve/logs"), { recursive: true });
    await writeFile(join(appRoot, ".eve/logs/dev-test.log"), "diagnostic log\n");
  }
  await writeFile(join(appRoot, "node_modules/eve/docs/README.md"), "installed eve docs\n");
  return appRoot;
}

describe("self-modification filesystem", () => {
  it("mounts authored source read-write and traces, logs, and eve docs read-only", async () => {
    const appRoot = await createAppRoot();
    await withLocalDevCapability(appRoot, async () => {
      const filesystem = await createLocalSelfModificationFilesystem({
        appRoot,
        defaultFilesystem: new justBash.InMemoryFs(),
        justBash,
      });

      expect(await filesystem.readFile("/traces/trace-1/segments/span.otlp.json")).toBe("trace\n");
      await expect(
        filesystem.writeFile("/traces/trace-1/segments/span.otlp.json", "changed\n"),
      ).rejects.toThrow(/read-only file system/u);

      expect(await filesystem.readFile("/logs/dev-test.log")).toBe("diagnostic log\n");
      await expect(filesystem.writeFile("/logs/dev-test.log", "changed\n")).rejects.toThrow(
        /read-only file system/u,
      );

      expect(await filesystem.readFile("/eve-docs/README.md")).toBe("installed eve docs\n");
      await expect(filesystem.writeFile("/eve-docs/README.md", "changed\n")).rejects.toThrow(
        /read-only file system/u,
      );

      await filesystem.writeFile("/source/instructions.md", "authored\n");
      expect(await readFile(join(appRoot, "agent/instructions.md"), "utf8")).toBe("authored\n");
    });
  });

  it("uses the capability's authored root instead of the runtime snapshot", async () => {
    const authoredRoot = await createAppRoot();
    const runtimeRoot = await createAppRoot();

    await withLocalDevCapability(authoredRoot, async () => {
      const filesystem = await createLocalSelfModificationFilesystem({
        appRoot: runtimeRoot,
        defaultFilesystem: new justBash.InMemoryFs(),
        justBash,
      });

      await filesystem.writeFile("/source/instructions.md", "authored\n");
    });

    expect(await readFile(join(authoredRoot, "agent/instructions.md"), "utf8")).toBe("authored\n");
    await expect(readFile(join(runtimeRoot, "agent/instructions.md"), "utf8")).rejects.toThrow(
      /ENOENT/u,
    );
  });

  it("mounts empty trace and log directories when nothing has been captured", async () => {
    const appRoot = await createAppRoot({ traces: false, logs: false });
    await withLocalDevCapability(appRoot, async () => {
      const filesystem = await createLocalSelfModificationFilesystem({
        appRoot,
        defaultFilesystem: new justBash.InMemoryFs(),
        justBash,
      });

      expect(await filesystem.readdir("/traces")).toEqual([]);
      expect(await filesystem.readdir("/logs")).toEqual([]);
    });
  });

  it("rejects mounting authored files without eve dev facilities", async () => {
    const appRoot = await createAppRoot();

    await expect(
      createLocalSelfModificationFilesystem({
        appRoot,
        defaultFilesystem: new justBash.InMemoryFs(),
        justBash,
      }),
    ).rejects.toThrow("Self-modification requires eve dev facilities");
  });
});
