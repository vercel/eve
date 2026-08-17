import { resolve } from "node:path";

import { MountableFs, OverlayFs, ReadWriteFs, type IFileSystem } from "just-bash";

export async function createSelfmodFilesystem(input: {
  readonly appRoot: string;
  readonly defaultFilesystem: IFileSystem;
}): Promise<IFileSystem> {
  await input.defaultFilesystem.mkdir("/source", { recursive: true });
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
          root: resolve(input.appRoot, "node_modules/eve/docs"),
        }),
        mountPoint: "/eve-docs",
      },
    ],
  });
}
