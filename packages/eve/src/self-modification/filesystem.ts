import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { getLocalDevCapability } from "eve/local-dev";

import type { JustBashFilesystem } from "#public/sandbox/just-bash-sandbox.js";

export async function createSelfModificationFilesystem(input: {
  readonly appRoot?: string;
  readonly defaultFilesystem: JustBashFilesystem;
  resolveProjectPath?(path: string): string;
  readonly justBash: typeof import("just-bash");
}): Promise<JustBashFilesystem> {
  const capability = getLocalDevCapability();
  if (capability === undefined) {
    throw new Error(
      "Self-modification requires eve dev facilities for the authored source tree and watcher.",
    );
  }

  const { MountableFs, OverlayFs, ReadWriteFs } = input.justBash;
  const appRoot = capability.appRoot;
  const traceRoot = resolve(appRoot, ".eve/traces/v1");
  const logsRoot = resolve(appRoot, ".eve/logs");
  await Promise.all([
    input.defaultFilesystem.mkdir("/source", { recursive: true }),
    mkdir(traceRoot, { recursive: true }),
    mkdir(logsRoot, { recursive: true }),
  ]);
  return new MountableFs({
    base: input.defaultFilesystem,
    mounts: [
      {
        filesystem: new ReadWriteFs({
          allowSymlinks: false,
          maxFileReadSize: Number.MAX_SAFE_INTEGER,
          root: resolve(appRoot, "agent"),
        }),
        mountPoint: "/source",
      },
      {
        filesystem: new OverlayFs({
          mountPoint: "/",
          readOnly: true,
          root: traceRoot,
        }),
        mountPoint: "/traces",
      },
      {
        filesystem: new OverlayFs({
          mountPoint: "/",
          readOnly: true,
          root: logsRoot,
        }),
        mountPoint: "/logs",
      },
      {
        filesystem: new OverlayFs({
          mountPoint: "/",
          readOnly: true,
          root: resolve(appRoot, "node_modules/eve/docs"),
        }),
        mountPoint: "/eve-docs",
      },
    ],
  });
}
