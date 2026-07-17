import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  DurableDynamicSkillBaselineFileMetadata,
  DurableDynamicSkillMetadata,
} from "#context/keys.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import {
  digestMaterializedSkillPackage,
  isSafeMaterializedSkillPackageFilePath,
  type NormalizedSkillPackageFile,
} from "#shared/skill-package.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const AUTHORED_BASELINES_DIRECTORY = ".eve-dynamic-skill-authored-baselines";

export async function captureAuthoredSkillBaseline(input: {
  readonly name: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly DurableDynamicSkillBaselineFileMetadata[]> {
  const skillRoot = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  const visibleRoot = `${skillRoot}/${input.name}`;
  const files = await readFiles({ root: visibleRoot, sandbox: input.sandbox });
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new Error(`Cannot overlay authored skill "${input.name}" without its baseline SKILL.md.`);
  }

  const baselineRoot = `${skillRoot}/${AUTHORED_BASELINES_DIRECTORY}/${input.name}`;
  await input.sandbox.removePath({ force: true, path: baselineRoot, recursive: true });
  await writeFiles({ files, root: baselineRoot, sandbox: input.sandbox });
  return files.map((file) => ({
    contentDigest: digestFile(file.content),
    relativePath: file.relativePath,
  }));
}

export async function readVerifiedAuthoredSkillBaseline(input: {
  readonly baseline: readonly DurableDynamicSkillBaselineFileMetadata[];
  readonly name: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly NormalizedSkillPackageFile[]> {
  const skillRoot = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  const files = await readFiles({
    root: `${skillRoot}/${AUTHORED_BASELINES_DIRECTORY}/${input.name}`,
    sandbox: input.sandbox,
  });
  const expected = new Map(input.baseline.map((file) => [file.relativePath, file.contentDigest]));
  if (
    !pathsEqual(
      files.map((file) => file.relativePath),
      [...expected.keys()].sort(),
    )
  ) {
    throw new Error(`Authored skill baseline for "${input.name}" has an unexpected path set.`);
  }
  for (const file of files) {
    if (digestFile(file.content) !== expected.get(file.relativePath)) {
      throw new Error(`Authored skill baseline for "${input.name}" failed byte validation.`);
    }
  }
  return files;
}

export async function dynamicSkillPackageMatchesSandbox(input: {
  readonly metadata: DurableDynamicSkillMetadata;
  readonly sandbox: SandboxSession;
}): Promise<boolean> {
  if (input.metadata.contentDigest === undefined || input.metadata.relativePaths === undefined) {
    return false;
  }

  if (input.metadata.authoredBaseline !== undefined) {
    try {
      await readVerifiedAuthoredSkillBaseline({
        baseline: input.metadata.authoredBaseline,
        name: input.metadata.name,
        sandbox: input.sandbox,
      });
    } catch {
      return false;
    }
  }

  const skillRoot = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  const files = await readFiles({
    root: `${skillRoot}/${input.metadata.name}`,
    sandbox: input.sandbox,
  });
  const dynamicPaths = new Set(input.metadata.relativePaths);
  const expectedPaths = new Set(dynamicPaths);
  for (const baselineFile of input.metadata.authoredBaseline ?? []) {
    expectedPaths.add(baselineFile.relativePath);
  }
  if (
    !pathsEqual(
      files.map((file) => file.relativePath),
      [...expectedPaths].sort(),
    )
  )
    return false;

  const dynamicFiles = files.filter((file) => dynamicPaths.has(file.relativePath));
  if (
    digestMaterializedSkillPackage({
      description: input.metadata.description,
      files: dynamicFiles,
      name: input.metadata.name,
    }) !== input.metadata.contentDigest
  ) {
    return false;
  }

  const filesByPath = new Map(files.map((file) => [file.relativePath, file]));
  return (input.metadata.authoredBaseline ?? []).every((baselineFile) => {
    if (dynamicPaths.has(baselineFile.relativePath)) return true;
    const file = filesByPath.get(baselineFile.relativePath);
    return file !== undefined && digestFile(file.content) === baselineFile.contentDigest;
  });
}

export async function writeVisibleSkillPackage(input: {
  readonly files: readonly NormalizedSkillPackageFile[];
  readonly name: string;
  readonly sandbox: SandboxSession;
}): Promise<void> {
  const skillRoot = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  await writeFiles({
    files: input.files,
    root: `${skillRoot}/${input.name}`,
    sandbox: input.sandbox,
  });
}

async function readFiles(input: {
  readonly root: string;
  readonly sandbox: SandboxSession;
}): Promise<readonly NormalizedSkillPackageFile[]> {
  const result = await input.sandbox.run({
    command: `if [ -d ${shellQuote(input.root)} ]; then find ${shellQuote(input.root)} -type f -print0; fi`,
  });
  if (result.exitCode !== 0)
    throw new Error(`Failed to enumerate skill package at "${input.root}".`);

  const prefix = `${input.root}/`;
  const relativePaths = result.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => {
      if (!path.startsWith(prefix)) throw new Error("Skill package enumeration escaped its root.");
      const relativePath = path.slice(prefix.length);
      if (!isSafeMaterializedSkillPackageFilePath(relativePath)) {
        throw new Error("Skill package enumeration returned an unsafe path.");
      }
      return relativePath;
    })
    .sort();

  const files: NormalizedSkillPackageFile[] = [];
  for (const relativePath of relativePaths) {
    const content = await input.sandbox.readBinaryFile({ path: `${input.root}/${relativePath}` });
    if (content === null) throw new Error("Skill package changed during validation.");
    files.push({ content: Buffer.from(content), relativePath });
  }
  return files;
}

async function writeFiles(input: {
  readonly files: readonly NormalizedSkillPackageFile[];
  readonly root: string;
  readonly sandbox: SandboxSession;
}): Promise<void> {
  for (const file of input.files) {
    await input.sandbox.writeBinaryFile({
      content: file.content,
      path: `${input.root}/${file.relativePath}`,
    });
  }
}

function digestFile(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
