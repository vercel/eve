import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { MaterializableSkillPackage } from "#shared/skill-package.js";

// Writing a skill package to disk, for the compiler's workspace resources: Node only, apart from
// the package itself (`skill-package.ts`), which a browser session's skills use too.

/**
 * Writes a normalized package under a compiled workspace resource node root.
 *
 * For a `rootPath` of `.eve/compile/workspace-resources/__root__` and a skill
 * named `research`, files land under `skills/research/`.
 */
export async function writeSkillPackageDirectory(input: {
  readonly rootPath: string;
  readonly skill: MaterializableSkillPackage;
}): Promise<void> {
  for (const file of input.skill.files) {
    const filePath = join(input.rootPath, "skills", input.skill.name, file.relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
  }
}
