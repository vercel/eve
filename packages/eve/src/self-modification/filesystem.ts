import { mkdir } from "node:fs/promises";
import type { IFileSystem } from "just-bash";

export async function createSelfModificationFilesystem(input: {
  readonly defaultFilesystem: IFileSystem;
  resolveProjectPath(path: string): string;
  readonly justBash: typeof import("just-bash");
}): Promise<IFileSystem> {
  const { MountableFs, OverlayFs, ReadWriteFs } = input.justBash;
  const traceRoot = input.resolveProjectPath(".eve/traces/v1");
  const logsRoot = input.resolveProjectPath(".eve/logs");
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
          root: input.resolveProjectPath("agent"),
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
          root: input.resolveProjectPath("node_modules/eve/docs"),
        }),
        mountPoint: "/eve-docs",
      },
    ],
  });
}
