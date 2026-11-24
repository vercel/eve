import { hostBytes } from "#runtime-env/host-bytes.js";
import { concatBytes, utf8Bytes } from "#shared/bytes.js";
import { sha256Hex } from "#shared/digest.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import { resolveSandboxSkillRoot, resolveSandboxSkillWritePath } from "#shared/skill-paths.js";

export interface NormalizedSkillPackageFile {
  readonly content: Uint8Array;
  readonly relativePath: string;
}

export interface MaterializableSkillPackage {
  readonly deferred?: boolean;
  readonly description: string;
  readonly files: readonly NormalizedSkillPackageFile[];
  readonly license?: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name: string;
}

export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function skillPackageRevision(skill: MaterializableSkillPackage): string {
  return sha256Hex(
    concatBytes(
      skill.files.flatMap((file) => [
        utf8Bytes(`${file.relativePath}\0${file.content.byteLength}\0`),
        file.content,
      ]),
    ),
  );
}

export function normalizeSkillPackage(input: NamedSkillDefinition): MaterializableSkillPackage {
  assertSafeSkillPackageName(input.name);

  const files: NormalizedSkillPackageFile[] = [
    {
      content: hostBytes(utf8Bytes(input.content)),
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
    deferred: input.deferred,
    description: input.description,
    files,
    license: input.license,
    content: input.content,
    metadata: input.metadata === undefined ? undefined : { ...input.metadata },
    name: input.name,
  };
}

export async function writeSkillPackageToSandbox(input: {
  readonly sandbox: SandboxSession;
  readonly skill: MaterializableSkillPackage;
}): Promise<void> {
  const files = await Promise.all(
    input.skill.files.map(async (file) => ({
      content: file.content,
      path: await resolveSandboxSkillWritePath({
        name: input.skill.name,
        relativePath: file.relativePath,
        sandbox: input.sandbox,
      }),
    })),
  );
  await input.sandbox.writeFiles({ files });
}

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

function assertSafeSkillPackageName(name: string): void {
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

function contentToBuffer(content: string | Uint8Array): Uint8Array {
  return hostBytes(typeof content === "string" ? utf8Bytes(content) : content);
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
