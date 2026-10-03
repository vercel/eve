import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDiskSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  type SkillFileSource,
} from "#channel/skill-files.js";

describe("createDiskSkillFileSource", () => {
  let root: string;
  let source: SkillFileSource;

  // `skills/triage` holds regular files beside a symlinked file and a
  // symlinked directory; `skills/linked` is a symlinked skill root; and the
  // source itself is opened through `alias`, a symlink to `skills`, since a
  // real deployment's compile directory can sit behind one (macOS's tmpdir
  // does), so containment must compare real paths.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-files-"));
    const skills = join(root, "skills");
    const alias = join(root, "alias");
    const outside = join(root, "outside");
    await mkdir(join(skills, "triage", "references"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(skills, "triage", "SKILL.md"), "# Triage\n");
    await writeFile(join(skills, "triage", "references", "api.md"), "api\n");
    await writeFile(join(skills, "triage", "big.bin"), new Uint8Array(MAX_SKILL_FILE_BYTES + 1));
    await writeFile(join(outside, "secret.md"), "secret\n");
    await symlink(join(outside, "secret.md"), join(skills, "triage", "leaked.md"));
    await symlink(outside, join(skills, "triage", "escape"));
    await symlink(join(skills, "triage"), join(skills, "linked"));
    await symlink(skills, alias);
    source = createDiskSkillFileSource(alias);
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("lists only regular files reached through real directories", async () => {
    await expect(source.listFiles("triage")).resolves.toEqual([
      { path: "SKILL.md", size: 9 },
      { path: "big.bin", size: MAX_SKILL_FILE_BYTES + 1 },
      { path: "references/api.md", size: 4 },
    ]);
    await expect(source.listFiles("linked")).resolves.toEqual([]);
    await expect(source.listFiles("missing")).resolves.toEqual([]);
  });

  it("reads regular files under the real skill root", async () => {
    await expect(source.readFile("triage", "SKILL.md")).resolves.toEqual(
      new TextEncoder().encode("# Triage\n"),
    );
    await expect(source.readFile("triage", "references/api.md")).resolves.toEqual(
      new TextEncoder().encode("api\n"),
    );
  });

  it.each([
    ["linked", "SKILL.md", "unknown-file"],
    ["missing", "SKILL.md", "unknown-file"],
    ["triage", "missing.md", "unknown-file"],
    ["triage", "references/missing.md", "unknown-file"],
    ["triage", "SKILL.md/below", "unknown-file"],
    ["triage", "references", "unknown-file"],
    ["triage", "leaked.md", "unknown-file"],
    ["triage", "escape/secret.md", "unknown-file"],
    ["triage", "big.bin", "too-large"],
  ])("refuses %s/%s as %s", async (skill, path, code) => {
    await expect(source.readFile(skill, path)).rejects.toMatchObject({ code });
  });
});
