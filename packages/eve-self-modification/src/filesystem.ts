import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { IFileSystem } from "just-bash";

export async function createSelfModificationFilesystem(input: {
  readonly appRoot: string;
  readonly defaultFilesystem: IFileSystem;
  readonly justBash: typeof import("just-bash");
}): Promise<IFileSystem> {
  const { MountableFs, OverlayFs, ReadWriteFs } = input.justBash;
  const traceRoot = resolve(input.appRoot, ".eve/traces/v1");
  await Promise.all([
    input.defaultFilesystem.mkdir("/source", { recursive: true }),
    mkdir(traceRoot, { recursive: true }),
  ]);
  return new MountableFs({
    base: input.defaultFilesystem,
    mounts: [
      {
        filesystem: new ReadWriteFs({
          allowSymlinks: false,
          maxFileReadSize: Number.MAX_SAFE_INTEGER,
          root: resolve(input.appRoot, "agent"),
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
          root: resolve(input.appRoot, "node_modules/eve/docs"),
        }),
        mountPoint: "/eve-docs",
      },
    ],
  });
}
