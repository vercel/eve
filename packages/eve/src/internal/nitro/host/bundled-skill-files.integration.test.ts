import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_SKILL_FILE_BYTES } from "#channel/skill-files.js";
import { prepareBundledSkillFilesPlugin } from "#internal/nitro/host/bundled-skill-files.js";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

describe("prepareBundledSkillFilesPlugin", () => {
  let root: string;
  let stagingDirectory: string;
  let pluginSource: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-bundled-skill-files-"));
    const skillsRoot = join(root, "skills");
    stagingDirectory = join(root, "staging");
    await mkdir(join(skillsRoot, "triage", "references"), { recursive: true });
    await mkdir(join(skillsRoot, "triage", "empty"), { recursive: true });
    await mkdir(join(skillsRoot, "review"), { recursive: true });
    await writeFile(join(skillsRoot, "triage", "SKILL.md"), "# Triage\n");
    await writeFile(join(skillsRoot, "triage", "references", "shared.md"), "shared\n");
    await writeFile(
      join(skillsRoot, "triage", "big.bin"),
      new Uint8Array(MAX_SKILL_FILE_BYTES + 1),
    );
    await writeFile(join(skillsRoot, "review", "SKILL.md"), "shared\n");
    pluginSource = await prepareBundledSkillFilesPlugin({
      skills: ["triage", "review", "triage"],
      skillsRoot,
      stagingDirectory,
    });
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("stages each distinct file once under its digest and skips over-limit files", async () => {
    expect((await readdir(stagingDirectory)).sort()).toEqual(
      [sha256("# Triage\n"), sha256("shared\n"), "index.json"].sort(),
    );
    await expect(readFile(join(stagingDirectory, sha256("shared\n")), "utf8")).resolves.toBe(
      "shared\n",
    );
  });

  it("imports each staged digest once with the bytes: prefix", () => {
    const imports = pluginSource.match(/import\("bytes:[^"]+"\)/g) ?? [];
    expect(imports).toHaveLength(2);
    expect(pluginSource).toContain(
      `import(${JSON.stringify(`bytes:${join(stagingDirectory, sha256("shared\n"))}`)})`,
    );
  });

  it("indexes sorted skills with sizes, digests, and empty directories", async () => {
    const indexPath = join(stagingDirectory, "index.json");
    expect(pluginSource).toContain(`import skills from ${JSON.stringify(`text:${indexPath}`)};`);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(index).toEqual([
      ["review", [["SKILL.md", 7, sha256("shared\n")]], []],
      [
        "triage",
        [
          ["SKILL.md", 9, sha256("# Triage\n")],
          ["big.bin", MAX_SKILL_FILE_BYTES + 1, null],
          ["references/shared.md", 7, sha256("shared\n")],
        ],
        ["empty", "references"],
      ],
    ]);
  });
});
