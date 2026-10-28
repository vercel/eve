import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalTemplate } from "./sync-local";

const entry = {
  github: {
    owner: "vercel",
    repo: "eve",
    ref: "main",
    pathPrefix: "apps/templates/local-agent",
  },
  files: ["agent/instructions.md"],
};

describe("local template snapshots", () => {
  it("reads new and edited working-tree files without requiring them to exist on GitHub", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-template-sync-"));
    const directory = join(root, entry.github.pathPrefix);
    try {
      await mkdir(join(directory, "agent"), { recursive: true });
      await writeFile(join(directory, "README.md"), "# Local agent\nRun setup before deploying.\n");
      await writeFile(join(directory, "agent/instructions.md"), "Help Alice plan her trip.\n");
      const snapshot = await readLocalTemplate(entry, root, "head-revision");
      expect(snapshot).toEqual({
        readme: "# Local agent\nRun setup before deploying.\n",
        sourceRevision: "head-revision",
        files: [
          {
            relativePath: "agent/instructions.md",
            language: "markdown",
            contents: "Help Alice plan her trip.\n",
          },
        ],
      });
      await writeFile(join(directory, "agent/instructions.md"), "Help Bob plan his trip.\n");
      expect((await readLocalTemplate(entry, root, "head-revision"))?.files[0].contents).toBe(
        "Help Bob plan his trip.\n",
      );
      await rm(join(directory, "agent/instructions.md"));
      await expect(readLocalTemplate(entry, root, "head-revision")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not substitute local files for external repositories or allow reads outside the source", async () => {
    const root = join(tmpdir(), "eve-template-sync-no-files-needed");
    const external = { ...entry, github: { ...entry.github, owner: "another-owner" } };
    expect(await readLocalTemplate(external, root, "head")).toBeUndefined();
    await expect(
      readLocalTemplate(
        { ...entry, github: { ...entry.github, pathPrefix: "../outside" } },
        root,
        "head",
      ),
    ).rejects.toThrow(/escapes its source directory/);
    await expect(
      readLocalTemplate({ ...entry, files: ["../../../../outside"] }, root, "head"),
    ).rejects.toThrow(/escapes its source directory/);
  });
});
