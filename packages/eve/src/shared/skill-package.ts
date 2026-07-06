import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SandboxSession } from "#shared/sandbox-session.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import { resolveSandboxSkillRoot, resolveSandboxSkillWritePath } from "#shared/skill-paths.js";

export interface NormalizedSkillPackageFile {
  readonly content: Buffer;
  readonly relativePath: string;
}

export interface MaterializableSkillPackage {
  readonly description: string;
  readonly files: readonly NormalizedSkillPackageFile[];
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name: string;
}

/**
 * Normalizes one named skill package into the concrete files eve writes to
 * workspace resources or the live sandbox.
 */
export function normalizeSkillPackage(input: NamedSkillDefinition): MaterializableSkillPackage {
  assertSafeSkillPackageName(input.name);

  const files: NormalizedSkillPackageFile[] = [
    {
      content: Buffer.from(input.markdown, "utf8"),
      relativePath: "SKILL.md",
    },
  ];

  for (const [relativePath, content] of Object.entries(input.files ?? {})) {
    assertSafeSkillPackageFilePath(relativePath);
    files.push({
      content: contentToBuffer(content),
      relativePath,
    });
  }

  files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  return {
    description: input.description,
    files,
    license: input.license,
    markdown: input.markdown,
    metadata: input.metadata === undefined ? undefined : { ...input.metadata },
    name: input.name,
  };
}

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

/**
 * Writes a normalized package into the live sandbox under
 * the sandbox skill root.
 */
export async function writeSkillPackageToSandbox(input: {
  readonly sandbox: SandboxSession;
  readonly skill: MaterializableSkillPackage;
}): Promise<void> {
  for (const file of input.skill.files) {
    await input.sandbox.writeBinaryFile({
      content: file.content,
      path: await resolveSandboxSkillWritePath({
        name: input.skill.name,
        relativePath: file.relativePath,
        sandbox: input.sandbox,
      }),
    });
  }
}

/**
 * Removes a skill package from the live sandbox.
 */
export async function removeSkillPackageFromSandbox(input: {
  readonly sandbox: SandboxSession;
  readonly name: string;
}): Promise<void> {
  assertSafeSkillPackageName(input.name);
  const root = await resolveSandboxSkillRoot({ sandbox: input.sandbox });

  await input.sandbox.removePath({
    force: true,
    path: `${root}/${input.name}`,
    recursive: true,
  });
}

/**
 * Validates a runtime-contributed skill name before it becomes one path
 * segment under the sandbox skill root.
 */
export function assertSafeSkillPackageName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(
      'Expected skill name to be a non-empty shell-safe path segment starting with an alphanumeric character and containing only alphanumerics, ".", "_", or "-".',
    );
  }
}

function assertSafeSkillPackageFilePath(relativePath: string): void {
  if (relativePath === "SKILL.md") {
    throw new Error('Skill package files must not include "SKILL.md"; eve generates it.');
  }

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Expected skill package file paths to be relative POSIX paths.");
  }
}

function contentToBuffer(content: string | Uint8Array): Buffer {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }

  return Buffer.from(content);
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
