import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createJustBashHandle,
  type BashSandbox,
} from "#execution/sandbox/bindings/just-bash-runtime.js";

describe("just-bash sandbox deletion", () => {
  it("disposes the interpreter and removes the session root", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "eve-just-bash-delete-"));
    await writeFile(join(rootPath, "state.txt"), "persisted");
    const dispose = vi.fn(async () => {});
    const sandbox = {
      captureState: vi.fn(async () => null),
      dispose,
      readFileBytes: vi.fn(async () => null),
      removePath: vi.fn(async () => {}),
      rootPath,
      sessionKey: "session-key",
      async spawn() {
        throw new Error("spawn is not used by this test");
      },
      writeFiles: vi.fn(async () => {}),
    } satisfies BashSandbox;
    const handle = createJustBashHandle(sandbox, "just-bash");

    await handle.delete();

    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(access(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
