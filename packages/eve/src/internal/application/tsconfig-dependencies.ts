import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type ParseError, parse as parseJsonc } from "#compiled/jsonc-parser/index.js";

/**
 * Resolves every local tsconfig/jsconfig file that can affect bundling from
 * one package root: root configs plus their extends chain.
 */
export async function resolveTsConfigDependencyPaths(appRoot: string): Promise<string[]> {
  const rootConfigPaths = await resolveRootTsConfigPaths(appRoot);
  const resolvedConfigPaths = new Set<string>();
  const visitingConfigPaths = new Set<string>();

  for (const rootConfigPath of rootConfigPaths) {
    await collectTsConfigDependencyPaths({
      configPath: rootConfigPath,
      resolvedConfigPaths,
      visitingConfigPaths,
    });
  }

  return [...resolvedConfigPaths].sort((left, right) => left.localeCompare(right));
}

export async function resolveRootTsConfigPaths(appRoot: string): Promise<string[]> {
  const paths = new Set<string>([join(appRoot, "tsconfig.json"), join(appRoot, "jsconfig.json")]);

  try {
    const directoryEntries = await readdir(appRoot, {
      withFileTypes: true,
    });

    for (const entry of directoryEntries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!/^tsconfig\..+\.json$/i.test(entry.name)) {
        continue;
      }

      paths.add(join(appRoot, entry.name));
    }
  } catch {
    // Best-effort dependency resolution: skip directory reads when unavailable.
  }

  return [...paths];
}

export async function collectTsConfigDependencyPaths(input: {
  readonly configPath: string;
  readonly resolvedConfigPaths: Set<string>;
  readonly visitingConfigPaths: Set<string>;
}): Promise<void> {
  const resolvedConfigPath = resolve(input.configPath);

  if (
    input.resolvedConfigPaths.has(resolvedConfigPath) ||
    input.visitingConfigPaths.has(resolvedConfigPath)
  ) {
    return;
  }

  const configSource = await readTextFileIfExists(resolvedConfigPath);

  if (configSource === undefined) {
    return;
  }

  input.resolvedConfigPaths.add(resolvedConfigPath);
  input.visitingConfigPaths.add(resolvedConfigPath);

  try {
    const extendsSpecifiers = extractTsConfigExtendsSpecifiers(configSource);

    for (const extendsSpecifier of extendsSpecifiers) {
      for (const extendedConfigPath of resolveTsConfigExtendsTargetPaths({
        configPath: resolvedConfigPath,
        extendsSpecifier,
      })) {
        await collectTsConfigDependencyPaths({
          configPath: extendedConfigPath,
          resolvedConfigPaths: input.resolvedConfigPaths,
          visitingConfigPaths: input.visitingConfigPaths,
        });
      }
    }
  } finally {
    input.visitingConfigPaths.delete(resolvedConfigPath);
  }
}

export async function readTextFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export function parseTsConfigObject(source: string): Record<string, unknown> | undefined {
  const parseErrors: ParseError[] = [];
  const parsedConfig = parseJsonc(source, parseErrors, {
    allowTrailingComma: true,
  });

  if (
    parseErrors.length > 0 ||
    parsedConfig === null ||
    typeof parsedConfig !== "object" ||
    Array.isArray(parsedConfig)
  ) {
    return undefined;
  }

  return parsedConfig as Record<string, unknown>;
}

export function extractTsConfigExtendsSpecifiers(source: string): string[] {
  const parsedConfig = parseTsConfigObject(source);

  if (parsedConfig === undefined) {
    return [];
  }

  const extendsValue = parsedConfig.extends;

  if (typeof extendsValue === "string") {
    return extendsValue.length > 0 ? [extendsValue] : [];
  }

  if (!Array.isArray(extendsValue)) {
    return [];
  }

  return extendsValue.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function resolveTsConfigExtendsTargetPaths(input: {
  readonly configPath: string;
  readonly extendsSpecifier: string;
}): string[] {
  const uniquePaths = new Set<string>();

  if (isTsConfigFilePath(input.extendsSpecifier)) {
    for (const candidate of resolveFileExtendsCandidates({
      configPath: input.configPath,
      extendsSpecifier: input.extendsSpecifier,
    })) {
      uniquePaths.add(candidate);
    }
  } else {
    for (const candidate of resolvePackageExtendsCandidates({
      configPath: input.configPath,
      extendsSpecifier: input.extendsSpecifier,
    })) {
      uniquePaths.add(candidate);
    }
  }

  return [...uniquePaths];
}

export function resolveFirstExistingTsConfigExtendsTarget(input: {
  readonly configPath: string;
  readonly extendsSpecifier: string;
}): string | undefined {
  for (const candidate of resolveTsConfigExtendsTargetPaths(input)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function resolveFileExtendsCandidates(input: {
  readonly configPath: string;
  readonly extendsSpecifier: string;
}): string[] {
  const resolvedPath = resolve(dirname(input.configPath), input.extendsSpecifier);
  const candidates = new Set<string>();

  candidates.add(resolvedPath);

  if (!resolvedPath.endsWith(".json")) {
    candidates.add(`${resolvedPath}.json`);
    candidates.add(join(resolvedPath, "tsconfig.json"));
  }

  return [...candidates];
}

function resolvePackageExtendsCandidates(input: {
  readonly configPath: string;
  readonly extendsSpecifier: string;
}): string[] {
  const candidates = new Set<string>([input.extendsSpecifier]);

  if (!input.extendsSpecifier.endsWith(".json")) {
    candidates.add(`${input.extendsSpecifier}.json`);
    candidates.add(`${input.extendsSpecifier}/tsconfig.json`);
  }

  const resolvedPaths = new Set<string>();
  const resolver = createRequire(input.configPath);

  for (const candidate of candidates) {
    try {
      resolvedPaths.add(resolver.resolve(candidate));
    } catch {
      // Best-effort dependency resolution: unresolved package tsconfig targets
      // are ignored so callers can decide whether to validate more strictly.
    }
  }

  return [...resolvedPaths];
}

export function isTsConfigFilePath(specifier: string): boolean {
  if (specifier.startsWith(".")) {
    return true;
  }

  if (isAbsolute(specifier)) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(specifier);
}
