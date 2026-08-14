import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { pathExists } from "#setup/path-exists.js";

import { applyFileWritePlan, planFileWrite, rollbackFileWrites } from "./bounded-write-plan.js";

const createScratchDirectory = useTemporaryDirectories();

describe("bounded write plan", () => {
  it("applies planned regular files and preserves existing modes", async () => {
    const root = await createScratchDirectory("eve-write-plan-");
    const destination = join(root, "package.json");
    await writeFile(destination, "before\n");
    await chmod(destination, 0o744);
    const plan = await planFileWrite({
      bytes: Buffer.from("after\n"),
      destination,
      root,
    });

    const applied = await applyFileWritePlan(root, [plan]);

    await expect(readFile(destination, "utf8")).resolves.toBe("after\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o744);
    await rollbackFileWrites(applied);
    await expect(readFile(destination, "utf8")).resolves.toBe("before\n");
  });

  it("refuses a destination changed after planning", async () => {
    const root = await createScratchDirectory("eve-write-race-");
    const destination = join(root, "package.json");
    await writeFile(destination, "before\n");
    const plan = await planFileWrite({ bytes: Buffer.from("eve\n"), destination, root });
    await writeFile(destination, "other writer\n");

    await expect(applyFileWritePlan(root, [plan])).rejects.toThrow("changed path");
    await expect(readFile(destination, "utf8")).resolves.toBe("other writer\n");
  });

  it("rolls back matching writes after a later write fails", async () => {
    const root = await createScratchDirectory("eve-write-rollback-");
    const created = join(root, "agent", "instructions.md");
    const first = await planFileWrite({
      bytes: Buffer.from("hello\n"),
      destination: created,
      root,
    });
    const blocked = join(root, "blocked", "file");
    const second = await planFileWrite({ bytes: Buffer.from("no\n"), destination: blocked, root });
    await writeFile(join(root, "blocked"), "not a directory");

    await expect(applyFileWritePlan(root, [first, second])).rejects.toThrow("non-directory");
    await expect(pathExists(created)).resolves.toBe(false);
  });

  it("preserves a path changed after apply instead of rolling it back", async () => {
    const root = await createScratchDirectory("eve-write-conflict-");
    const destination = join(root, "agent.ts");
    const plan = await planFileWrite({ bytes: Buffer.from("eve\n"), destination, root });
    const applied = await applyFileWritePlan(root, [plan]);
    await writeFile(destination, "other writer\n");

    await expect(rollbackFileWrites(applied)).resolves.toEqual([destination]);
    await expect(readFile(destination, "utf8")).resolves.toBe("other writer\n");
  });

  it("rejects symlink traversal", async () => {
    const root = await createScratchDirectory("eve-write-symlink-");
    const outside = await createScratchDirectory("eve-write-outside-");
    await mkdir(join(root, "agent"));
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, "agent", "tools"));

    await expect(
      planFileWrite({
        bytes: Buffer.from("unsafe\n"),
        destination: join(root, "agent", "tools", "unsafe.ts"),
        root,
      }),
    ).rejects.toThrow("symlink");
  });
});
