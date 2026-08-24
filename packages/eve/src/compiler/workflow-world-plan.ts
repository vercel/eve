import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "#compiled/zod/index.js";
import { resolveInstalledPackageRoot } from "#compiler/external-dependency-package-closure.js";
import { resolveExpectedWorkflowVersion } from "#internal/application/package.js";
import {
  assertWorkflowWorldCompatibility,
  type ValidatedWorkflowWorldCompatibility,
  type WorkflowWorldManifest,
} from "#internal/workflow/world-compatibility.js";
import {
  BUILT_IN_WORKFLOW_WORLD_TARGETS,
  classifyBuiltInWorkflowWorldTarget,
  isWorkflowWorldPackageName,
  type BuiltInWorkflowWorldTarget,
} from "#internal/workflow/world-target.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const WORKFLOW_WORLD_IGNORED_PACKAGE_PATH_SEGMENTS = new Set([
  ".eve",
  ".git",
  "node_modules",
  // Materialized packages live outside node_modules, where bundlers would
  // otherwise auto-load package build configuration as runtime semantics.
  "tsconfig.json",
]);

export interface CompiledNativeWorkflowWorldPlan {
  readonly kind: "native";
  readonly selection: "configured" | "host-default";
  readonly target: BuiltInWorkflowWorldTarget;
}

export interface CompiledWorkflowWorldPackageBacking {
  readonly contentSha256: string;
  readonly dependencies: Readonly<Record<string, string | null>>;
  readonly id: string;
  readonly manifestPath: string;
  readonly name: string;
  readonly rootPath: string;
  readonly sourceManifestPath: string;
  readonly sourceRootPath: string;
  readonly version: string;
}

export interface CompiledHostModuleWorkflowWorldPlan {
  readonly backing: {
    readonly entryPackageId: string;
    readonly entryPath: string;
    readonly identitySha256: string;
    readonly mode: "resolved" | "materialized";
    readonly packages: readonly CompiledWorkflowWorldPackageBacking[];
  };
  readonly kind: "host-module";
  readonly packageName: string;
  readonly protocol: ValidatedWorkflowWorldCompatibility;
  readonly selection: "configured";
}

/** Compiler-owned selection and physical backing for one configured World. */
export type CompiledWorkflowWorldPlan =
  | CompiledNativeWorkflowWorldPlan
  | CompiledHostModuleWorkflowWorldPlan;

const workflowWorldPackageBackingSchema: z.ZodType<CompiledWorkflowWorldPackageBacking> = z
  .object({
    contentSha256: z.string().regex(SHA256_PATTERN),
    dependencies: z.record(z.string(), z.string().nullable()).readonly(),
    id: z.string().min(1),
    manifestPath: z.string().min(1),
    name: z.string().min(1),
    rootPath: z.string().min(1),
    sourceManifestPath: z.string().min(1),
    sourceRootPath: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export const compiledWorkflowWorldPlanSchema: z.ZodType<CompiledWorkflowWorldPlan> = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("native"),
        selection: z.enum(["configured", "host-default"]),
        target: z.enum(BUILT_IN_WORKFLOW_WORLD_TARGETS),
      })
      .strict(),
    z
      .object({
        backing: z
          .object({
            entryPackageId: z.string().min(1),
            entryPath: z.string().min(1),
            identitySha256: z.string().regex(SHA256_PATTERN),
            mode: z.enum(["resolved", "materialized"]),
            packages: z.array(workflowWorldPackageBackingSchema).readonly(),
          })
          .strict(),
        kind: z.literal("host-module"),
        packageName: z.string().min(1),
        protocol: z
          .object({
            declaredPackageName: z.enum(["@workflow/core", "@workflow/world"]),
            declaredRange: z.string().min(1),
            expectedVersion: z.string().min(1),
          })
          .strict(),
        selection: z.literal("configured"),
      })
      .strict(),
  ])
  .superRefine((plan, context) => {
    for (const issue of validateCompiledWorkflowWorldPlan(plan)) {
      context.addIssue({ code: "custom", message: issue });
    }
  });

/** Resolves and identifies a configured World without evaluating its module. */
export async function compileWorkflowWorldPlan(input: {
  readonly appRoot: string;
  readonly selection: "configured" | "host-default";
  readonly target: string;
}): Promise<CompiledWorkflowWorldPlan> {
  const builtInTarget = classifyBuiltInWorkflowWorldTarget(input.target);
  if (builtInTarget !== undefined) {
    return { kind: "native", selection: input.selection, target: builtInTarget };
  }
  if (input.selection !== "configured") {
    throw new Error(
      "A host-default Workflow world must select eve's native local or vercel target.",
    );
  }
  if (!isWorkflowWorldPackageName(input.target)) {
    throw new Error(
      `Workflow world target ${JSON.stringify(input.target)} must be "local", "vercel", or a bare package name. Relative paths, absolute paths, URLs, and package subpaths are not supported.`,
    );
  }

  const anchorPath = join(resolve(input.appRoot), "package.json");
  const resolver = createRequire(anchorPath);
  let resolvedEntryPath: string;
  try {
    resolvedEntryPath = resolver.resolve(input.target);
  } catch (error) {
    throw new Error(
      `Cannot resolve configured Workflow world package ${JSON.stringify(input.target)} from ${JSON.stringify(input.appRoot)}. Install it in the application before compiling.`,
      { cause: error },
    );
  }

  const entryPath = await realpath(resolvedEntryPath);
  const entryPackage = await resolvePackageAtEntry(entryPath, input.target);
  const protocol = assertConfiguredWorldCompatibility(input.target, entryPackage.manifest);
  const graph = await createPackageBackingGraph(entryPackage);
  const backing = {
    entryPackageId: graph.entryPackageId,
    entryPath,
    identitySha256: createWorkflowWorldBackingIdentity({
      entryPackageId: graph.entryPackageId,
      entryPath,
      packages: graph.packages,
      protocol,
    }),
    mode: "resolved" as const,
    packages: graph.packages,
  };
  const plan: CompiledHostModuleWorkflowWorldPlan = {
    backing,
    kind: "host-module",
    packageName: input.target,
    protocol,
    selection: "configured",
  };
  const issues = validateCompiledWorkflowWorldPlan(plan);
  if (issues.length > 0) {
    throw new Error(`Invalid compiled Workflow world plan: ${issues.join(" ")}`);
  }
  return plan;
}

/** Re-hashes the exact compiler-selected package graph without resolving names. */
export async function assertCompiledWorkflowWorldPlanIntegrity(
  plan: CompiledWorkflowWorldPlan,
): Promise<void> {
  if (plan.kind === "native") return;

  const issues = validateCompiledWorkflowWorldPlan(plan);
  if (issues.length > 0) {
    throw new Error(`Invalid compiled Workflow world plan: ${issues.join(" ")}`);
  }

  const packages: CompiledWorkflowWorldPackageBacking[] = [];
  for (const selectedPackage of plan.backing.packages) {
    const canonicalRoot = await realpath(selectedPackage.rootPath);
    const canonicalManifest = await realpath(selectedPackage.manifestPath);
    if (canonicalRoot !== selectedPackage.rootPath) {
      throw new Error(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} moved from ${JSON.stringify(selectedPackage.rootPath)} to ${JSON.stringify(canonicalRoot)} after compilation.`,
      );
    }
    if (canonicalManifest !== selectedPackage.manifestPath) {
      throw new Error(
        `Workflow world package manifest backing ${JSON.stringify(selectedPackage.id)} moved after compilation.`,
      );
    }
    const manifest = await readPackageManifest(selectedPackage.manifestPath);
    if (manifest.name !== selectedPackage.name || manifest.version !== selectedPackage.version) {
      throw new Error(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} no longer matches its compiled package identity.`,
      );
    }
    const contentSha256 = await hashPackageContents(selectedPackage.rootPath);
    if (contentSha256 !== selectedPackage.contentSha256) {
      throw new Error(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} changed after compilation: expected ${JSON.stringify(selectedPackage.contentSha256)}, received ${JSON.stringify(contentSha256)}.`,
      );
    }
    packages.push({ ...selectedPackage, contentSha256 });
  }

  const packagesById = new Map(
    packages.map((selectedPackage) => [selectedPackage.id, selectedPackage]),
  );
  const entryPackage = packagesById.get(plan.backing.entryPackageId);
  if (entryPackage === undefined) {
    throw new Error(
      `Workflow world entry package ${JSON.stringify(plan.backing.entryPackageId)} is absent from its backing graph.`,
    );
  }
  const currentExpectedWorkflowVersion = resolveExpectedWorkflowVersion();
  if (currentExpectedWorkflowVersion === undefined) {
    throw new Error(
      `Cannot validate configured Workflow world ${JSON.stringify(plan.packageName)} because eve's bundled @workflow/core version is unavailable.`,
    );
  }
  if (currentExpectedWorkflowVersion !== plan.protocol.expectedVersion) {
    throw new Error(
      `Workflow world plan expects eve Workflow version ${JSON.stringify(plan.protocol.expectedVersion)}, but the current eve runtime provides ${JSON.stringify(currentExpectedWorkflowVersion)}.`,
    );
  }
  const currentProtocol = assertWorkflowWorldCompatibility({
    expectedWorkflowVersion: plan.protocol.expectedVersion,
    worldManifest: await readPackageManifest(entryPackage.manifestPath),
    worldPackageName: plan.packageName,
  });
  if (JSON.stringify(currentProtocol) !== JSON.stringify(plan.protocol)) {
    throw new Error("Workflow world protocol binding changed after compilation.");
  }
  if (plan.backing.mode === "materialized") {
    for (const selectedPackage of packages) {
      for (const [dependencyName, dependencyId] of Object.entries(selectedPackage.dependencies)) {
        if (dependencyId === null) continue;
        const expectedDependency = packagesById.get(dependencyId);
        if (expectedDependency === undefined) {
          throw new Error(
            `Workflow world package backing ${JSON.stringify(selectedPackage.id)} references missing dependency backing ${JSON.stringify(dependencyId)}.`,
          );
        }
        const bindingPath = join(
          selectedPackage.rootPath,
          "node_modules",
          ...dependencyName.split("/"),
        );
        let currentDependencyRoot: string;
        try {
          currentDependencyRoot = await realpath(bindingPath);
        } catch (error) {
          throw new Error(
            `Materialized Workflow world dependency ${JSON.stringify(dependencyName)} is missing from backing ${JSON.stringify(selectedPackage.id)}.`,
            { cause: error },
          );
        }
        if (currentDependencyRoot !== expectedDependency.rootPath) {
          throw new Error(
            `Materialized Workflow world dependency ${JSON.stringify(dependencyName)} no longer points to compiled backing ${JSON.stringify(dependencyId)}.`,
          );
        }
      }
    }
  }
  const canonicalEntryPath = await realpath(plan.backing.entryPath);
  if (canonicalEntryPath !== plan.backing.entryPath) {
    throw new Error(
      `Workflow world entry moved from ${JSON.stringify(plan.backing.entryPath)} to ${JSON.stringify(canonicalEntryPath)} after compilation.`,
    );
  }
  const identitySha256 = createWorkflowWorldBackingIdentity({
    entryPackageId: plan.backing.entryPackageId,
    entryPath: plan.backing.entryPath,
    packages,
    protocol: plan.protocol,
  });
  if (identitySha256 !== plan.backing.identitySha256) {
    throw new Error(
      `Workflow world backing identity changed after compilation: expected ${JSON.stringify(plan.backing.identitySha256)}, received ${JSON.stringify(identitySha256)}.`,
    );
  }
}

/** Authored package roots watched for a selected custom World. */
export function compiledWorkflowWorldPackageRoots(
  plan: CompiledWorkflowWorldPlan,
): readonly string[] {
  return plan.kind === "host-module"
    ? plan.backing.packages.map((selectedPackage) => selectedPackage.sourceRootPath)
    : [];
}

export function validateCompiledWorkflowWorldPlan(
  plan: CompiledWorkflowWorldPlan,
): readonly string[] {
  if (plan.kind === "native") return [];

  const issues: string[] = [];
  if (!isWorkflowWorldPackageName(plan.packageName)) {
    issues.push(
      `Host-module Workflow world target ${JSON.stringify(plan.packageName)} is not a package name.`,
    );
  }
  if (!isAbsolute(plan.backing.entryPath)) {
    issues.push("Host-module Workflow world entryPath must be absolute.");
  }
  if (plan.backing.packages.length === 0) {
    issues.push("Host-module Workflow world backing must contain its entry package.");
    return issues;
  }

  const packagesById = new Map<string, CompiledWorkflowWorldPackageBacking>();
  for (const selectedPackage of plan.backing.packages) {
    if (packagesById.has(selectedPackage.id)) {
      issues.push(
        `Duplicate Workflow world package backing id ${JSON.stringify(selectedPackage.id)}.`,
      );
      continue;
    }
    packagesById.set(selectedPackage.id, selectedPackage);
    if (!isAbsolute(selectedPackage.rootPath) || !isAbsolute(selectedPackage.manifestPath)) {
      issues.push(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} must use absolute physical paths.`,
      );
    }
    if (
      !isAbsolute(selectedPackage.sourceRootPath) ||
      !isAbsolute(selectedPackage.sourceManifestPath)
    ) {
      issues.push(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} must use absolute source paths.`,
      );
    }
    if (
      resolve(selectedPackage.manifestPath) !==
      join(resolve(selectedPackage.rootPath), "package.json")
    ) {
      issues.push(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} has a manifest outside its package root.`,
      );
    }
    if (
      resolve(selectedPackage.sourceManifestPath) !==
      join(resolve(selectedPackage.sourceRootPath), "package.json")
    ) {
      issues.push(
        `Workflow world package backing ${JSON.stringify(selectedPackage.id)} has a source manifest outside its source package root.`,
      );
    }
  }

  const entryPackage = packagesById.get(plan.backing.entryPackageId);
  if (entryPackage === undefined) {
    issues.push(
      `Workflow world entry package ${JSON.stringify(plan.backing.entryPackageId)} is absent from its backing graph.`,
    );
  } else {
    if (entryPackage.name !== plan.packageName) {
      issues.push(
        `Workflow world package name ${JSON.stringify(plan.packageName)} does not match entry backing ${JSON.stringify(entryPackage.name)}.`,
      );
    }
    if (!isPathInsideOrEqual(plan.backing.entryPath, entryPackage.rootPath)) {
      issues.push("Workflow world entryPath must be contained by its selected package root.");
    }
  }

  for (const selectedPackage of plan.backing.packages) {
    for (const [dependencyName, dependencyId] of Object.entries(selectedPackage.dependencies)) {
      if (!isWorkflowWorldPackageName(dependencyName)) {
        issues.push(
          `Workflow world package backing ${JSON.stringify(selectedPackage.id)} has invalid dependency name ${JSON.stringify(dependencyName)}.`,
        );
      }
      if (dependencyId !== null && !packagesById.has(dependencyId)) {
        issues.push(
          `Workflow world package backing ${JSON.stringify(selectedPackage.id)} references missing dependency backing ${JSON.stringify(dependencyId)}.`,
        );
      }
    }
  }

  if (issues.length === 0) {
    const identity = createWorkflowWorldBackingIdentity({
      entryPackageId: plan.backing.entryPackageId,
      entryPath: plan.backing.entryPath,
      packages: plan.backing.packages,
      protocol: plan.protocol,
    });
    if (identity !== plan.backing.identitySha256) {
      issues.push(
        `Workflow world backing identity does not match its serialized package graph: expected ${JSON.stringify(identity)}, received ${JSON.stringify(plan.backing.identitySha256)}.`,
      );
    }
  }

  return issues;
}

export function assertValidCompiledWorkflowWorldPlan(plan: CompiledWorkflowWorldPlan): void {
  const issues = validateCompiledWorkflowWorldPlan(plan);
  if (issues.length > 0) {
    throw new Error(`Invalid compiled Workflow world plan: ${issues.join(" ")}`);
  }
}

interface ResolvedPackage {
  readonly manifest: VersionedPackageManifest;
  readonly manifestPath: string;
  readonly rootPath: string;
}

interface PackageManifest extends WorkflowWorldManifest {
  readonly name?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly version?: string;
}

interface VersionedPackageManifest extends PackageManifest {
  readonly version: string;
}

interface RuntimeDependency {
  readonly name: string;
  readonly required: boolean;
}

async function resolvePackageAtEntry(
  entryPath: string,
  expectedName: string,
): Promise<ResolvedPackage> {
  let directory = dirname(entryPath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = await readPackageManifest(manifestPath);
      if (manifest.name === expectedName) {
        if (manifest.version === undefined || manifest.version.length === 0) {
          throw new Error(
            `Workflow world package ${JSON.stringify(expectedName)} must declare a non-empty version.`,
          );
        }
        return {
          manifest: { ...manifest, version: manifest.version },
          manifestPath: await realpath(manifestPath),
          rootPath: await realpath(directory),
        };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Resolved Workflow world entry ${JSON.stringify(entryPath)} is not contained by package ${JSON.stringify(expectedName)}.`,
      );
    }
    directory = parent;
  }
}

async function createPackageBackingGraph(entryPackage: ResolvedPackage): Promise<{
  readonly entryPackageId: string;
  readonly packages: readonly CompiledWorkflowWorldPackageBacking[];
}> {
  const packagesByRoot = new Map<string, string>();
  const packagesById = new Map<string, CompiledWorkflowWorldPackageBacking>();
  const visit = async (selectedPackage: ResolvedPackage, id: string): Promise<string> => {
    const existingId = packagesByRoot.get(selectedPackage.rootPath);
    if (existingId !== undefined) return existingId;
    packagesByRoot.set(selectedPackage.rootPath, id);

    const dependencies: Record<string, string | null> = {};
    const placeholder: CompiledWorkflowWorldPackageBacking = {
      contentSha256: await hashPackageContents(selectedPackage.rootPath),
      dependencies,
      id,
      manifestPath: selectedPackage.manifestPath,
      name: selectedPackage.manifest.name ?? "",
      rootPath: selectedPackage.rootPath,
      sourceManifestPath: selectedPackage.manifestPath,
      sourceRootPath: selectedPackage.rootPath,
      version: selectedPackage.manifest.version,
    };
    packagesById.set(id, placeholder);

    for (const dependencyDefinition of collectRuntimeDependencies(selectedPackage.manifest)) {
      const dependency = await tryResolveDependencyPackage(
        selectedPackage,
        dependencyDefinition.name,
      );
      if (dependency === undefined && dependencyDefinition.required) {
        throw new Error(
          `Workflow world package ${JSON.stringify(selectedPackage.manifest.name)} requires dependency ${JSON.stringify(dependencyDefinition.name)}, but it cannot be resolved from ${JSON.stringify(selectedPackage.rootPath)}.`,
        );
      }
      dependencies[dependencyDefinition.name] =
        dependency === undefined
          ? null
          : await visit(dependency, `${id}>${dependencyDefinition.name}`);
    }
    return id;
  };

  const entryPackageId = await visit(entryPackage, "root");
  return {
    entryPackageId,
    packages: [...packagesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function collectRuntimeDependencies(manifest: PackageManifest): readonly RuntimeDependency[] {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      required:
        !Object.hasOwn(manifest.optionalDependencies ?? {}, name) &&
        (Object.hasOwn(manifest.dependencies ?? {}, name) ||
          (Object.hasOwn(manifest.peerDependencies ?? {}, name) &&
            manifest.peerDependenciesMeta?.[name]?.optional !== true)),
    }));
}

async function tryResolveDependencyPackage(
  parentPackage: ResolvedPackage,
  dependencyName: string,
): Promise<ResolvedPackage | undefined> {
  try {
    const dependencyRoot = resolveInstalledPackageRoot(dependencyName, parentPackage.rootPath);
    return await resolvePackageAtEntry(join(dependencyRoot, "package.json"), dependencyName);
  } catch {
    return undefined;
  }
}

async function hashPackageContents(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("eve-workflow-world-package-v1\0");
  await hashPackageDirectory({ hash, logicalPath: ".", physicalPath: rootPath, rootPath });
  return hash.digest("hex");
}

async function hashPackageDirectory(input: {
  readonly hash: ReturnType<typeof createHash>;
  readonly logicalPath: string;
  readonly physicalPath: string;
  readonly rootPath: string;
}): Promise<void> {
  const entries = await readdir(input.physicalPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (WORKFLOW_WORLD_IGNORED_PACKAGE_PATH_SEGMENTS.has(entry.name)) continue;
    const logicalPath =
      input.logicalPath === "." ? entry.name : `${input.logicalPath}/${entry.name}`;
    const physicalPath = join(input.physicalPath, entry.name);
    const stats = await lstat(physicalPath);

    if (stats.isSymbolicLink()) {
      const declaredTarget = await readlink(physicalPath);
      const resolvedTarget = resolve(dirname(physicalPath), declaredTarget);
      const canonicalTarget = await realpath(physicalPath);
      const targetSegments = relative(input.rootPath, canonicalTarget).split(sep);
      if (
        isAbsolute(declaredTarget) ||
        !isPathInsideOrEqual(resolvedTarget, input.rootPath) ||
        !isPathInsideOrEqual(canonicalTarget, input.rootPath) ||
        targetSegments.some((segment) => WORKFLOW_WORLD_IGNORED_PACKAGE_PATH_SEGMENTS.has(segment))
      ) {
        throw new Error(
          `Workflow world package ${JSON.stringify(input.rootPath)} contains unsupported external or ignored-path symlink ${JSON.stringify(logicalPath)}.`,
        );
      }
      input.hash.update(logicalPath).update("\0link\0").update(declaredTarget).update("\0");
      continue;
    }
    if (stats.isDirectory()) {
      await hashPackageDirectory({ ...input, logicalPath, physicalPath });
      continue;
    }
    if (!stats.isFile()) continue;

    const contents = await readFile(physicalPath);
    input.hash
      .update(logicalPath)
      .update("\0file\0")
      .update(String(contents.byteLength))
      .update("\0")
      .update(contents)
      .update("\0");
  }
}

function createWorkflowWorldBackingIdentity(input: {
  readonly entryPackageId: string;
  readonly entryPath: string;
  readonly packages: readonly CompiledWorkflowWorldPackageBacking[];
  readonly protocol: ValidatedWorkflowWorldCompatibility;
}): string {
  const entryPackage = input.packages.find(
    (selectedPackage) => selectedPackage.id === input.entryPackageId,
  );
  const entryRelativePath =
    entryPackage === undefined
      ? input.entryPath
      : toPortablePath(relative(entryPackage.rootPath, input.entryPath));
  const semanticGraph = {
    entryPackageId: input.entryPackageId,
    entryRelativePath,
    packages: [...input.packages]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((selectedPackage) => ({
        contentSha256: selectedPackage.contentSha256,
        dependencies: Object.fromEntries(
          Object.entries(selectedPackage.dependencies).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        id: selectedPackage.id,
        name: selectedPackage.name,
        version: selectedPackage.version,
      })),
    protocol: input.protocol,
  };
  return createHash("sha256").update(JSON.stringify(semanticGraph)).digest("hex");
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  const manifestSchema: z.ZodType<PackageManifest> = z
    .object({
      dependencies: z.record(z.string(), z.string()).optional(),
      name: z.string().optional(),
      optionalDependencies: z.record(z.string(), z.string()).optional(),
      peerDependencies: z.record(z.string(), z.string()).optional(),
      peerDependenciesMeta: z
        .record(z.string(), z.object({ optional: z.boolean().optional() }).passthrough())
        .optional(),
      version: z.string().optional(),
    })
    .passthrough();
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function assertConfiguredWorldCompatibility(
  packageName: string,
  worldManifest: WorkflowWorldManifest,
): ValidatedWorkflowWorldCompatibility {
  const expectedWorkflowVersion = resolveExpectedWorkflowVersion();
  if (expectedWorkflowVersion === undefined) {
    throw new Error(
      `Cannot validate configured Workflow world ${JSON.stringify(packageName)} because eve's bundled @workflow/core version is unavailable.`,
    );
  }
  return assertWorkflowWorldCompatibility({
    expectedWorkflowVersion,
    worldManifest,
    worldPackageName: packageName,
  });
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}
