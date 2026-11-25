import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { MaterializableSkillPackage } from "#shared/skill-package.js";

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
