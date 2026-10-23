import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type BundledSkillFileEntry,
  comparePaths,
  createDiskSkillFileSource,
  MAX_SKILL_FILE_BYTES,
} from "#channel/skill-files.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";

/**
 * Stages the root agent's materialized `skills/` tree for a production build
 * and returns the source of a Nitro plugin that installs it as
 * `BundledSkillFiles`.
 *
 * The listing and bytes come from {@link createDiskSkillFileSource}, the same
 * source dev reads, so both modes agree on which files exist.
 *
 * Each shipped file is staged as `<stagingDirectory>/<sha256>` and imported
 * with Nitro's `bytes:` prefix, which inlines it as a `Uint8Array` in its own
 * lazily loaded chunk whatever its name or encoding. Identical files share
 * one import. Staging by digest keeps authored names, which may hold `?` or
 * `#`, out of import specifiers. Files over {@link MAX_SKILL_FILE_BYTES} are
 * indexed by size only, and directories are indexed so empty ones survive.
 * The index is staged as `<stagingDirectory>/index.json`.
 */
export async function prepareBundledSkillFilesPlugin(input: {
  /** Build-owned directory the staged files are written to. */
  readonly stagingDirectory: string;
  readonly skills: readonly string[];
  /** The materialized `skills/` directory of the root agent's workspace resources. */
  readonly skillsRoot: string;
}): Promise<string> {
  const source = createDiskSkillFileSource(resolve(input.skillsRoot));
  await rm(input.stagingDirectory, { force: true, recursive: true });
  await mkdir(input.stagingDirectory, { recursive: true });

  const skills: [string, BundledSkillFileEntry[], readonly string[]][] = [];
  const staged = new Map<string, string>();
  for (const skill of [...new Set(input.skills)].sort(comparePaths)) {
    const files: BundledSkillFileEntry[] = [];
    for (const { path, size } of await source.listFiles(skill)) {
      if (size > MAX_SKILL_FILE_BYTES) {
        files.push([path, size, null]);
        continue;
      }
      // Hash and stage the bytes that were read, not a second read of the path.
      const bytes = await source.readFile(skill, path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!staged.has(sha256)) {
        const stagedPath = join(input.stagingDirectory, sha256);
        await writeFile(stagedPath, bytes);
        staged.set(sha256, stagedPath);
      }
      files.push([path, bytes.byteLength, sha256]);
    }
    skills.push([skill, files, await source.listDirectories(skill)]);
  }
  // Inlined JS would expose authored names to Nitro's `replace` plugin, which
  // rewrites text like `import.meta.dev`; `text:` modules are excluded from it.
  const indexPath = join(input.stagingDirectory, "index.json");
  await writeFile(indexPath, JSON.stringify(skills));

  const installModulePath = resolvePackageSourceFilePath("src/channel/skill-files.ts");
  return [
    `import { installBundledSkillFiles } from ${stringifyEsmImportSpecifier(installModulePath)};`,
    `import skills from ${JSON.stringify(`text:${indexPath}`)};`,
    "const files = {",
    ...[...staged].map(
      ([sha256, path]) =>
        `  ${JSON.stringify(sha256)}: () => import(${JSON.stringify(`bytes:${path}`)}),`,
    ),
    "};",
    "export default function installBundledSkillFilesPlugin() {",
    "  installBundledSkillFiles({",
    "    skills: JSON.parse(skills),",
    "    read: async (sha256) => (await files[sha256]()).default,",
    "  });",
    "}",
  ].join("\n");
}
