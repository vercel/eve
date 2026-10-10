import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  comparePaths,
  createDiskSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  SKILL_FILES_INDEX_KEY,
  SKILL_FILES_INDEX_SERVER_ASSET_BASE,
  SKILL_FILES_SERVER_ASSET_BASE,
  skillFileStorageKey,
  type SkillFilesIndex,
  type SkillFilesIndexEntry,
} from "#channel/skill-files.js";

/** One Nitro `serverAssets` entry. */
export interface SkillServerAssetDirectory {
  readonly baseName: string;
  readonly dir: string;
}

/**
 * Stages the root agent's materialized `skills/` tree as Nitro server assets
 * for a production build, and returns the `serverAssets` entries to register.
 *
 * The listing and bytes come from {@link createDiskSkillFileSource}, the same
 * source dev reads, so both modes agree on which files exist.
 *
 * Nitro picks how to inline a server asset from its file name: text MIME
 * types become UTF-8 strings, which loses bytes that are not valid UTF-8,
 * unstorage decodes any string starting with `base64:`, and an empty string
 * is dropped by Nitro's `r.default || r`. So each shipped file is written as
 * `<stagingDirectory>/files/<sha256>.bin`, which Nitro always inlines as a
 * `Uint8Array`. Identical files share one asset. Real paths, sizes, and
 * digests go into an eve-owned index registered as its own server asset.
 * Files over {@link MAX_SKILL_FILE_BYTES} are indexed by size only, and
 * directories are indexed so empty ones survive the build.
 */
export async function prepareSkillServerAssets(input: {
  /** Build-owned directory the staged assets and the index are written to. */
  readonly stagingDirectory: string;
  readonly skills: readonly string[];
  /** The materialized `skills/` directory of the root agent's workspace resources. */
  readonly skillsRoot: string;
}): Promise<SkillServerAssetDirectory[]> {
  const source = createDiskSkillFileSource(resolve(input.skillsRoot));
  const filesDirectory = join(input.stagingDirectory, "files");
  const indexDirectory = join(input.stagingDirectory, "index");
  await rm(input.stagingDirectory, { force: true, recursive: true });
  await mkdir(filesDirectory, { recursive: true });
  await mkdir(indexDirectory, { recursive: true });

  const index: [string, SkillFilesIndexEntry[], readonly string[]][] = [];
  for (const skill of [...new Set(input.skills)].sort(comparePaths)) {
    const files: SkillFilesIndexEntry[] = [];
    for (const { path, size } of await source.listFiles(skill)) {
      if (size > MAX_SKILL_FILE_BYTES) {
        files.push([path, size, null]);
        continue;
      }
      // Hash and stage the bytes that were read, not a second read of the path.
      const bytes = await source.readFile(skill, path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(filesDirectory, skillFileStorageKey(sha256)), bytes);
      files.push([path, bytes.byteLength, sha256]);
    }
    index.push([skill, files, await source.listDirectories(skill)]);
  }

  const skillFilesIndex: SkillFilesIndex = { version: 1, skills: index };
  await writeFile(join(indexDirectory, SKILL_FILES_INDEX_KEY), JSON.stringify(skillFilesIndex));
  return [
    { baseName: SKILL_FILES_INDEX_SERVER_ASSET_BASE, dir: indexDirectory },
    { baseName: SKILL_FILES_SERVER_ASSET_BASE, dir: filesDirectory },
  ];
}
