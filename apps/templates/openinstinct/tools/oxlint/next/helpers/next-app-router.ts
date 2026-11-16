import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { z } from "zod";

import type { ESTree, Visitor } from "@oxlint/plugins";

import { isStringLiteral } from "../../shared/literals.ts";

const require = createRequire(import.meta.url);

let nextRouteUtilities: ReturnType<typeof loadNextRouteUtilities> | undefined;

const getNextRouteUtilities = () =>
  (nextRouteUtilities ??= loadNextRouteUtilities());

type RouteUtilityResult =
  | boolean
  | string
  | { readonly interceptedRoute: string };
type RouteUtilityFunction = (value: string) => RouteUtilityResult;

const routeUtilityFunctionSchema = z.custom<RouteUtilityFunction>(
  (value) => value instanceof Function,
  "The installed Next.js route utilities are incompatible."
);

const appPathModuleSchema = z.object({
  normalizeAppPath: routeUtilityFunctionSchema,
});
const interceptionRouteModuleSchema = z.object({
  extractInterceptionRouteInformation: routeUtilityFunctionSchema,
  isInterceptionRouteAppPath: routeUtilityFunctionSchema,
});
const normalizedAppPathSchema = z.string({
  error: "Next.js returned an invalid normalized app path.",
});
const interceptionRouteFlagSchema = z.boolean({
  error: "Next.js returned an invalid interception-route flag.",
});
const interceptionRouteInformationSchema = z.object(
  { interceptedRoute: z.string() },
  { error: "Next.js returned invalid interception-route information." }
);

function loadNextRouteUtilities() {
  const appPathModule: unknown = require("next/dist/shared/lib/router/utils/app-paths.js");
  const interceptionRouteModule: unknown = require("next/dist/shared/lib/router/utils/interception-routes.js");

  const appPaths = appPathModuleSchema.parse(appPathModule);
  const interceptionRoutes = interceptionRouteModuleSchema.parse(
    interceptionRouteModule
  );

  return {
    normalizeAppPath: (value: string) =>
      normalizedAppPathSchema.parse(appPaths.normalizeAppPath(value)),
    isInterceptionRouteAppPath: (value: string) =>
      interceptionRouteFlagSchema.parse(
        interceptionRoutes.isInterceptionRouteAppPath(value)
      ),
    extractInterceptionRouteInformation: (value: string) =>
      interceptionRouteInformationSchema.parse(
        interceptionRoutes.extractInterceptionRouteInformation(value)
      ),
  };
}

export const PRIVATE_ROUTE_DIRECTORIES = new Set([
  "_actions",
  "_components",
  "_data",
  "_lib",
]);

type ImportGraph = Map<string, Set<string>>;

const appImportGraphCache = new Map<string, ImportGraph>();
const descendantPageCache = new Map<string, boolean>();

export const normalizePath = (filePath: string) => path.resolve(filePath);

export const isWithin = (filePath: string, directory: string) => {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const findSourceDirectory = (filename: string, cwd: string) => {
  const sourceDirectory = path.join(cwd, "src");
  return isWithin(filename, sourceDirectory) ? sourceDirectory : cwd;
};

export const findAppDirectory = (filename: string): string | undefined => {
  let directory = path.dirname(filename);

  while (directory !== path.dirname(directory)) {
    if (path.basename(directory) === "app") return directory;
    directory = path.dirname(directory);
  }
  return undefined;
};

export const getAppRoute = (filename: string, appDirectory: string) => {
  const {
    extractInterceptionRouteInformation,
    isInterceptionRouteAppPath,
    normalizeAppPath,
  } = getNextRouteUtilities();
  const relativeRoute = path
    .relative(appDirectory, path.dirname(filename))
    .split(path.sep)
    .join("/");
  const normalizedRoute = normalizeAppPath(`/${relativeRoute}`);

  return isInterceptionRouteAppPath(normalizedRoute)
    ? extractInterceptionRouteInformation(normalizedRoute).interceptedRoute
    : normalizedRoute;
};

export const resolveLocalImport = (
  filename: string,
  source: string,
  sourceDirectory: string
): string | undefined => {
  const alias = /^@(agent|app|db|evals|shared|tests|tools|web)\/(.+)$/u.exec(
    source
  );
  if (alias?.[1] && alias[2]) {
    return normalizePath(path.join(sourceDirectory, alias[1], alias[2]));
  }

  if (source.startsWith(".")) {
    return normalizePath(path.resolve(path.dirname(filename), source));
  }
  return undefined;
};

const resolveImportFile = (target: string): string | undefined => {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.jsx`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
    path.join(target, "index.js"),
    path.join(target, "index.jsx"),
  ];

  if (target.endsWith(".js")) {
    candidates.push(target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx");
  }

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
};

const listSourceFiles = (directory: string): string[] => {
  const files: string[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
};

export const hasDescendantPage = (directory: string): boolean => {
  const cached = descendantPageCache.get(directory);
  if (cached !== undefined) return cached;

  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

    const childDirectory = path.join(directory, entry.name);
    const childEntries = fs.readdirSync(childDirectory, {
      withFileTypes: true,
    });
    if (
      childEntries.some(
        (child) => child.isFile() && /^page\.[jt]sx?$/.test(child.name)
      ) ||
      hasDescendantPage(childDirectory)
    ) {
      descendantPageCache.set(directory, true);
      return true;
    }
  }

  descendantPageCache.set(directory, false);
  return false;
};

const getImportedSources = (contents: string) => {
  const sources: string[] = [];
  const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
  let match;

  while ((match = importPattern.exec(contents))) {
    const source = match[1];
    if (source) sources.push(source);
  }

  return sources;
};

export const getAppImportGraph = (
  appDirectory: string,
  sourceDirectory: string
): ImportGraph => {
  const cached = appImportGraphCache.get(appDirectory);
  if (cached) return cached;

  const importersByTarget: ImportGraph = new Map();
  for (const importer of listSourceFiles(appDirectory)) {
    const contents = fs.readFileSync(importer, "utf8");
    for (const source of getImportedSources(contents)) {
      const target = resolveLocalImport(importer, source, sourceDirectory);
      const targetFile = target && resolveImportFile(target);
      if (!targetFile || !isWithin(targetFile, appDirectory)) continue;

      const importers = importersByTarget.get(targetFile) ?? new Set<string>();
      importers.add(importer);
      importersByTarget.set(targetFile, importers);
    }
  }

  appImportGraphCache.set(appDirectory, importersByTarget);
  return importersByTarget;
};

const getRouteOwner = (filename: string, appDirectory: string) => {
  const segments = path.relative(appDirectory, filename).split(path.sep);
  const privateIndex = segments.findIndex((segment) =>
    PRIVATE_ROUTE_DIRECTORIES.has(segment)
  );
  const routeSegments =
    privateIndex >= 0 ? segments.slice(0, privateIndex) : segments.slice(0, -1);

  return path.join(appDirectory, ...routeSegments);
};

export const getCommonDirectory = (
  directories: string[]
): string | undefined => {
  const [first, ...rest] = directories.map((directory) =>
    normalizePath(directory).split(path.sep)
  );
  if (!first) return undefined;

  let length = first.length;
  for (const segments of rest) {
    length = Math.min(length, segments.length);
    let index = 0;
    while (index < length && first[index] === segments[index]) index += 1;
    length = index;
  }

  return first.slice(0, length).join(path.sep) || path.sep;
};

export const getConsumerRouteOwners = (
  filename: string,
  importGraph: ImportGraph,
  appDirectory: string,
  visited = new Set<string>()
): string[] => {
  if (visited.has(filename)) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(filename);
  const importers = importGraph.get(filename);
  if (!importers?.size) return [];

  return [...importers].flatMap((importer) => {
    const segments = path.relative(appDirectory, importer).split(path.sep);
    const isPrivateImporter = segments.some((segment) =>
      PRIVATE_ROUTE_DIRECTORIES.has(segment)
    );
    if (!isPrivateImporter) return [getRouteOwner(importer, appDirectory)];

    const transitiveOwners = getConsumerRouteOwners(
      importer,
      importGraph,
      appDirectory,
      nextVisited
    );
    return transitiveOwners.length
      ? transitiveOwners
      : [getRouteOwner(importer, appDirectory)];
  });
};

export const visitLocalImports = (
  checkImport: (node: ESTree.Node, source: string) => void
): Visitor => ({
  ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
    checkImport(node, node.source.value);
  },
  ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
    if (node.source) checkImport(node, node.source.value);
  },
  ImportDeclaration(node: ESTree.ImportDeclaration) {
    checkImport(node, node.source.value);
  },
  ImportExpression(node: ESTree.ImportExpression) {
    if (isStringLiteral(node.source)) {
      checkImport(node, node.source.value);
    }
  },
});
