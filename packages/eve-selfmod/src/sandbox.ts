import { resolve } from "node:path";

import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { MountableFs, ReadWriteFs } from "just-bash";

export default defineSandbox({
  backend: justbash({
    async filesystem({ appRoot, defaultFilesystem }) {
      await defaultFilesystem.mkdir("/source", { recursive: true });
      return new MountableFs({
        base: defaultFilesystem,
        mounts: [
          {
            filesystem: new ReadWriteFs({
              allowSymlinks: false,
              maxFileReadSize: Number.MAX_SAFE_INTEGER,
              root: resolve(appRoot, "agent"),
            }),
            mountPoint: "/source",
          },
        ],
      });
    },
  }),
});
