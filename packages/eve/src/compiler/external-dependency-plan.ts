import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertExternalDependencyPackageName,
  canonicalExternalDependencyScopes as canonicalScopes,
  compareExternalDependencyStrings as compareStrings,
  createCompiledExternalDependencySemanticHash,
  createExternalDependencyPlanEntry,
  createPackageContentHash,
  externalDependencyScopeSortKey as scopeSortKey,
  findResolvedPackageRoot,
  resolveInstalledPackageRoot,
} from "#compiler/external-dependency-package-closure.js";
import type {
  CompiledExternalDependencyPlan,
  CompiledExternalDependencyPlanEntry,
  CompiledExternalDependencyScope,
} from "#compiler/external-dependency-plan-schema.js";

export {
  assertExternalDependencyPackageName,
  createCompiledExternalDependencySemanticHash,
  createPackageContentHash,
  shouldCopyExternalDependencyPackagePath,
} from "#compiler/external-dependency-package-closure.js";
export {
  compiledExternalDependencyPackageSchema,
  compiledExternalDependencyPlanEntrySchema,
  compiledExternalDependencyPlanSchema,
  compiledExternalDependencyScopeSchema,
  type CompiledExternalDependencyPackage,
  type CompiledExternalDependencyPlan,
  type CompiledExternalDependencyPlanEntry,
  type CompiledExternalDependencyScope,
} from "#compiler/external-dependency-plan-schema.js";

export interface CompiledExternalDependencyRequest {
  readonly packageName: string;
  readonly scope: CompiledExternalDependencyScope;
}

export interface CompiledExternalDependencyImportResolution {
  readonly packageName: string;
  readonly resolvedPath: string;
}

export interface CompiledExternalDependencyPlanSession {
  /** Distinguishes compile-scoped namespace loads in the process-wide in-flight cache. */
  readonly cacheKey: string;
  /** Captures an ordinary package import and optionally records config-bootstrap witnesses. */
  captureResolvedPackage(input: {
    readonly packageName: string;
    readonly resolvedPackagePath: string;
    readonly witnessSourceRoot?: string;
  }): Promise<CompiledExternalDependencyPlan>;
  /** Produces the exact persisted plan from requests already registered before evaluation. */
  finalize(
    expectedRequests: readonly CompiledExternalDependencyRequest[],
  ): Promise<CompiledExternalDependencyPlan>;
  /** Returns the already-selected closure for the configured names on one binding. */
  planFor(packageNames: readonly string[]): CompiledExternalDependencyPlan;
  /** Selects and authenticates declared owner closures before their definitions execute. */
  register(requests: readonly CompiledExternalDependencyRequest[]): Promise<void>;
  /** Re-hashes every selected source package without changing the registered request set. */
  verify(): Promise<void>;
}

interface SelectedExternalDependencyEntry {
  readonly entry: CompiledExternalDependencyPlanEntry;
  readonly request: CompiledExternalDependencyRequest;
}

/** Creates the single configured-package selection authority for one compiler operation. */
export function createCompiledExternalDependencyPlanSession(): CompiledExternalDependencyPlanSession {
  const cacheKey = randomUUID();
  const candidatePromisesByOwnerRoot = new Map<
    string,
    Promise<CompiledExternalDependencyPlanEntry>
  >();
  const registeredEntriesByRequest = new Map<string, CompiledExternalDependencyPlanEntry>();
  const registeredRequestsByKey = new Map<string, CompiledExternalDependencyRequest>();
  const selectedByPackageName = new Map<string, SelectedExternalDependencyEntry>();
  const witnessesByOwnerRoot = new Map<string, CompiledExternalDependencyPlanEntry[]>();

  const candidateForRequest = (
    request: CompiledExternalDependencyRequest,
  ): Promise<CompiledExternalDependencyPlanEntry> => {
    const key = externalDependencyWitnessKey(request.packageName, request.scope.sourceRoot);
    const existing = candidatePromisesByOwnerRoot.get(key);
    if (existing !== undefined) return existing;
    const promise = resolveExternalDependencyPlanEntry(request).then(
      withoutExternalDependencyScopes,
    );
    candidatePromisesByOwnerRoot.set(key, promise);
    return promise;
  };

  const assertMatchesSelection = (
    request: CompiledExternalDependencyRequest,
    candidate: CompiledExternalDependencyPlanEntry,
  ): void => {
    const selected = selectedByPackageName.get(request.packageName);
    if (selected === undefined) {
      selectedByPackageName.set(request.packageName, { entry: candidate, request });
      return;
    }
    if (selected.entry.semanticSha256 !== candidate.semanticSha256) {
      throw new Error(
        `External dependency "${request.packageName}" resolves to different executable closures from ${formatScope(selected.request.scope)} and ${formatScope(request.scope)}. eve requires one exact package instance per declared external dependency name.`,
      );
    }
  };

  const register = async (
    requests: readonly CompiledExternalDependencyRequest[],
  ): Promise<void> => {
    for (const request of canonicalExternalDependencyRequests(requests)) {
      assertExternalDependencyPackageName(request.packageName);
      const key = externalDependencyRequestKey(request);
      const existingRequest = registeredRequestsByKey.get(key);
      if (existingRequest !== undefined) continue;
      const candidate = await candidateForRequest(request);
      const witnessKey = externalDependencyWitnessKey(
        request.packageName,
        request.scope.sourceRoot,
      );
      for (const witness of witnessesByOwnerRoot.get(witnessKey) ?? []) {
        if (witness.semanticSha256 !== candidate.semanticSha256) {
          throw new Error(
            `External dependency "${request.packageName}" changed between config evaluation and compiler selection for ${formatScope(request.scope)}.`,
          );
        }
      }
      assertMatchesSelection(request, candidate);
      registeredRequestsByKey.set(key, request);
      registeredEntriesByRequest.set(key, candidate);
    }
  };

  const planFor = (packageNames: readonly string[]): CompiledExternalDependencyPlan => {
    const entries = canonicalPackageNames(packageNames).map((packageName) => {
      const selected = selectedByPackageName.get(packageName);
      if (selected === undefined) {
        throw new Error(
          `Configured external dependency "${packageName}" was not selected by the compiler before namespace loading.`,
        );
      }
      return selected.entry;
    });
    const plan = { entries };
    assertCompiledExternalDependencyPlanSemantics(plan);
    return plan;
  };

  return {
    cacheKey,
    async captureResolvedPackage(input) {
      assertExternalDependencyPackageName(input.packageName);
      const resolvedPackagePath = realpathSync.native(input.resolvedPackagePath);
      const packageRoot = findResolvedPackageRoot(input.packageName, resolvedPackagePath);
      const entry = await createExternalDependencyPlanEntry({
        packageName: input.packageName,
        packageRoot,
        scopes: [],
      });
      if (input.witnessSourceRoot !== undefined) {
        await recordBootstrapWitnesses({
          entry,
          selectedByPackageName,
          sourceRoot: input.witnessSourceRoot,
          witnessesByOwnerRoot,
        });
      }
      const plan = { entries: [entry] };
      assertCompiledExternalDependencyPlanSemantics(plan);
      return plan;
    },
    async finalize(expectedRequests) {
      const expected = canonicalExternalDependencyRequests(expectedRequests);
      const expectedKeys = new Set(expected.map(externalDependencyRequestKey));
      const extra = [...registeredRequestsByKey.keys()].find((key) => !expectedKeys.has(key));
      if (extra !== undefined) {
        const request = registeredRequestsByKey.get(extra)!;
        throw new Error(
          `Compiler-selected external dependency "${request.packageName}" from ${formatScope(request.scope)} is not declared by the compiled graph.`,
        );
      }
      const missing = expected.find(
        (request) => !registeredRequestsByKey.has(externalDependencyRequestKey(request)),
      );
      if (missing !== undefined) {
        throw new Error(
          `Compiled graph external dependency "${missing.packageName}" from ${formatScope(missing.scope)} was not selected before definition loading.`,
        );
      }

      const entriesByName = new Map<string, CompiledExternalDependencyPlanEntry>();
      for (const request of expected) {
        const candidate = registeredEntriesByRequest.get(externalDependencyRequestKey(request))!;
        const existing = entriesByName.get(request.packageName);
        if (existing === undefined) {
          entriesByName.set(request.packageName, {
            ...candidate,
            scopes: [request.scope],
          });
          continue;
        }
        entriesByName.set(request.packageName, {
          ...existing,
          scopes: canonicalScopes([...existing.scopes, request.scope]),
        });
      }
      const plan = {
        entries: [...entriesByName.values()].sort((left, right) =>
          compareStrings(left.id, right.id),
        ),
      };
      assertCompiledExternalDependencyPlanSemantics(plan);
      await verifyCompiledExternalDependencyPlanFiles(plan);
      return plan;
    },
    planFor,
    register,
    async verify() {
      const entriesBySource = new Map<string, CompiledExternalDependencyPlanEntry>();
      for (const entry of [
        ...[...selectedByPackageName.values()].map((selection) => selection.entry),
        ...[...witnessesByOwnerRoot.values()].flat(),
      ]) {
        entriesBySource.set(externalDependencyVerificationKey(entry), entry);
      }
      for (const entry of entriesBySource.values()) {
        await verifyCompiledExternalDependencyPlanFiles({ entries: [entry] });
      }
    },
  };
}

/** Resolves every declared runtime package into one owner-scoped immutable closure. */
export async function createCompiledExternalDependencyPlan(
  requests: readonly CompiledExternalDependencyRequest[],
): Promise<CompiledExternalDependencyPlan> {
  const session = createCompiledExternalDependencyPlanSession();
  await session.register(requests);
  return await session.finalize(requests);
}

/** Captures an already-resolved ordinary import without fabricating owner provenance. */
export async function createCompiledExternalDependencyCaptureFromPackagePath(input: {
  readonly packageName: string;
  readonly resolvedPackagePath: string;
}): Promise<CompiledExternalDependencyPlan> {
  assertExternalDependencyPackageName(input.packageName);
  const resolvedPackagePath = realpathSync.native(input.resolvedPackagePath);
  const packageRoot = findResolvedPackageRoot(input.packageName, resolvedPackagePath);
  const entry = await createExternalDependencyPlanEntry({
    packageName: input.packageName,
    packageRoot,
    scopes: [],
  });
  const plan = { entries: [entry] };
  assertCompiledExternalDependencyPlanSemantics(plan);
  return plan;
}

/** Validates the relocation-stable relational contract of a serialized plan. */
export function assertCompiledExternalDependencyPlanSemantics(
  plan: CompiledExternalDependencyPlan,
): void {
  let previousEntryId: string | undefined;
  const entryIds = new Set<string>();
  for (const entry of plan.entries) {
    assertExternalDependencyPackageName(entry.packageName);
    for (const pkg of entry.packages) {
      assertExternalDependencyPackageName(pkg.packageName);
      for (const dependency of pkg.dependencies) {
        assertExternalDependencyPackageName(dependency.packageName);
      }
    }
    if (entry.id !== entry.packageName) {
      throw new Error(
        `Compiled external dependency entry "${entry.id}" must use its package name as its id.`,
      );
    }
    if (previousEntryId !== undefined && compareStrings(previousEntryId, entry.id) >= 0) {
      throw new Error(
        `Compiled external dependency entry "${entry.id}" is duplicated or out of canonical order.`,
      );
    }
    previousEntryId = entry.id;
    entryIds.add(entry.id);
    const packagesById = new Map(entry.packages.map((pkg) => [pkg.id, pkg] as const));
    const rootPackage = packagesById.get(entry.rootPackageId);
    if (rootPackage === undefined) {
      throw new Error(
        `Compiled external dependency "${entry.id}" is missing its root package record.`,
      );
    }
    let previousPackageId: number | undefined;
    for (const pkg of entry.packages) {
      const packageId = Number(pkg.id);
      if (!Number.isSafeInteger(packageId) || packageId < 0) {
        throw new Error(
          `Compiled external dependency "${entry.id}" has invalid package id "${pkg.id}".`,
        );
      }
      if (previousPackageId !== undefined && previousPackageId >= packageId) {
        throw new Error(
          `Compiled external dependency "${entry.id}" package records are duplicated or out of canonical order.`,
        );
      }
      previousPackageId = packageId;
      if (!isAbsolute(pkg.resolvedPackageRoot)) {
        throw new Error(
          `Compiled external dependency "${entry.id}" package "${pkg.id}" has a non-absolute root.`,
        );
      }
      let previousDependencyName: string | undefined;
      for (const dependency of pkg.dependencies) {
        if (
          previousDependencyName !== undefined &&
          compareStrings(previousDependencyName, dependency.packageName) >= 0
        ) {
          throw new Error(
            `Compiled external dependency "${entry.id}" package "${pkg.id}" dependencies are duplicated or out of canonical order.`,
          );
        }
        previousDependencyName = dependency.packageName;
        if (!packagesById.has(dependency.packageId)) {
          throw new Error(
            `Compiled external dependency "${entry.id}" package "${pkg.id}" references missing package "${dependency.packageId}".`,
          );
        }
      }
    }
    const canonical = canonicalScopes(entry.scopes);
    if (JSON.stringify(canonical) !== JSON.stringify(entry.scopes)) {
      throw new Error(
        `Compiled external dependency "${entry.id}" scopes are duplicated or out of canonical order.`,
      );
    }
    const expectedSemanticSha256 = createCompiledExternalDependencySemanticHash(entry);
    if (entry.semanticSha256 !== expectedSemanticSha256) {
      throw new Error(
        `Compiled external dependency "${entry.id}" semantic digest does not match its package closure.`,
      );
    }
  }
  if (entryIds.size !== plan.entries.length) {
    throw new Error("Compiled external dependency plan contains duplicate entries.");
  }
}

/** Re-hashes the exact package bytes before any external namespace may execute. */
export async function verifyCompiledExternalDependencyPlanFiles(
  plan: CompiledExternalDependencyPlan,
): Promise<void> {
  assertCompiledExternalDependencyPlanSemantics(plan);
  for (const entry of plan.entries) {
    for (const pkg of entry.packages) {
      const actual = await createPackageContentHash(pkg.resolvedPackageRoot);
      if (actual !== pkg.contentSha256) {
        throw new Error(
          `Compiled external dependency "${entry.id}" package "${pkg.packageName}" changed after compilation.`,
        );
      }
    }
  }
}

/** Physical-path-free identity projection shared by module, host, and sandbox identities. */
export function createCompiledExternalDependencyPlanIdentity(
  plan: CompiledExternalDependencyPlan,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        plan.entries.map((entry) => ({ id: entry.id, semanticSha256: entry.semanticSha256 })),
      ),
    )
    .digest("hex");
}

/**
 * Resolves one actual configured import against the compiler-selected package
 * instance and condition set. The short-lived hook supplies Node's native ESM
 * resolver with an explicit parent without installing a process-wide loader.
 */
export function resolveCompiledExternalDependencyImport(
  plan: CompiledExternalDependencyPlan,
  specifier: string,
): CompiledExternalDependencyImportResolution | undefined {
  const entry = plan.entries.find(
    (candidate) =>
      specifier === candidate.packageName || specifier.startsWith(`${candidate.packageName}/`),
  );
  if (entry === undefined) return undefined;
  const rootPackage = entry.packages.find((pkg) => pkg.id === entry.rootPackageId);
  if (rootPackage === undefined) {
    throw new Error(`Cannot resolve external dependency "${specifier}" without its root package.`);
  }
  const canonicalPackageRoot = realpathSync.native(rootPackage.resolvedPackageRoot);
  const packageRelativeSpecifier = specifier.slice(entry.packageName.length);
  const canonicalSpecifier = `${rootPackage.packageName}${packageRelativeSpecifier}`;

  const resolutionId = randomUUID();
  const syntheticSpecifier = `eve-external-dependency:${resolutionId}`;
  const parentUrl = pathToFileURL(
    join(canonicalPackageRoot, ".eve-external-dependency-resolver.mjs"),
  );
  // Node's resolver cache does not include a caller-supplied condition set.
  // A unique parent query prevents another resolution from reusing a result
  // selected under different conditions.
  parentUrl.searchParams.set("resolution", resolutionId);
  const hooks = registerHooks({
    resolve(source, context, nextResolve) {
      if (source !== syntheticSpecifier) return nextResolve(source, context);
      return nextResolve(canonicalSpecifier, {
        ...context,
        conditions: [...entry.conditions],
        parentURL: parentUrl.href,
      });
    },
  });

  let resolvedUrl: string;
  try {
    resolvedUrl = import.meta.resolve(syntheticSpecifier);
  } catch (cause) {
    throw new Error(
      `Cannot resolve configured external import "${specifier}" from compiler-selected package "${entry.packageName}" under conditions ${entry.conditions.map((condition) => JSON.stringify(condition)).join(", ")}.`,
      { cause },
    );
  } finally {
    hooks.deregister();
  }
  if (!resolvedUrl.startsWith("file:")) {
    throw new Error(
      `Configured external import "${specifier}" resolved to unsupported URL "${resolvedUrl}".`,
    );
  }
  const resolvedPath = realpathSync.native(fileURLToPath(resolvedUrl));
  if (!isPathInsideOrEqual(resolvedPath, canonicalPackageRoot)) {
    throw new Error(
      `Configured external import "${specifier}" resolves outside compiler-selected package "${entry.packageName}".`,
    );
  }
  return { packageName: entry.packageName, resolvedPath };
}

async function resolveExternalDependencyPlanEntry(
  request: CompiledExternalDependencyRequest,
): Promise<CompiledExternalDependencyPlanEntry> {
  const packageRoot = resolveInstalledPackageRoot(request.packageName, request.scope.sourceRoot);
  return await createExternalDependencyPlanEntry({
    packageName: request.packageName,
    packageRoot,
    scopes: [request.scope],
  });
}

async function recordBootstrapWitnesses(input: {
  readonly entry: CompiledExternalDependencyPlanEntry;
  readonly selectedByPackageName: ReadonlyMap<string, SelectedExternalDependencyEntry>;
  readonly sourceRoot: string;
  readonly witnessesByOwnerRoot: Map<string, CompiledExternalDependencyPlanEntry[]>;
}): Promise<void> {
  const packagesById = new Map(input.entry.packages.map((pkg) => [pkg.id, pkg] as const));
  const candidateRoots = new Map<string, { packageName: string; packageRoot: string }>();
  const rootPackage = packagesById.get(input.entry.rootPackageId)!;
  candidateRoots.set(`${input.entry.packageName}\0${rootPackage.resolvedPackageRoot}`, {
    packageName: input.entry.packageName,
    packageRoot: rootPackage.resolvedPackageRoot,
  });
  for (const pkg of input.entry.packages) {
    for (const dependency of pkg.dependencies) {
      const target = packagesById.get(dependency.packageId)!;
      candidateRoots.set(`${dependency.packageName}\0${target.resolvedPackageRoot}`, {
        packageName: dependency.packageName,
        packageRoot: target.resolvedPackageRoot,
      });
    }
  }

  for (const { packageName, packageRoot } of candidateRoots.values()) {
    const witness =
      packageName === input.entry.packageName && packageRoot === rootPackage.resolvedPackageRoot
        ? input.entry
        : await createExternalDependencyPlanEntry({ packageName, packageRoot, scopes: [] });
    const selected = input.selectedByPackageName.get(packageName);
    if (selected !== undefined && selected.entry.semanticSha256 !== witness.semanticSha256) {
      throw new Error(
        `Config evaluation resolved external dependency "${packageName}" differently from the compiler-selected closure for ${formatScope(selected.request.scope)}.`,
      );
    }
    const key = externalDependencyWitnessKey(packageName, input.sourceRoot);
    const witnesses = input.witnessesByOwnerRoot.get(key) ?? [];
    if (!witnesses.some((candidate) => candidate.semanticSha256 === witness.semanticSha256)) {
      witnesses.push(witness);
      input.witnessesByOwnerRoot.set(key, witnesses);
    }
  }
}

function canonicalExternalDependencyRequests(
  requests: readonly CompiledExternalDependencyRequest[],
): CompiledExternalDependencyRequest[] {
  const byKey = new Map(
    requests.map((request) => [externalDependencyRequestKey(request), request] as const),
  );
  return [...byKey.values()].sort((left, right) => {
    const byPackage = compareStrings(left.packageName, right.packageName);
    if (byPackage !== 0) return byPackage;
    return compareStrings(scopeSortKey(left.scope), scopeSortKey(right.scope));
  });
}

function canonicalPackageNames(packageNames: readonly string[]): string[] {
  for (const packageName of packageNames) assertExternalDependencyPackageName(packageName);
  return [...new Set(packageNames)].sort(compareStrings);
}

function externalDependencyRequestKey(request: CompiledExternalDependencyRequest): string {
  return `${request.packageName}\0${scopeSortKey(request.scope)}`;
}

function externalDependencyWitnessKey(packageName: string, sourceRoot: string): string {
  return `${packageName}\0${realpathSync.native(resolve(sourceRoot))}`;
}

function withoutExternalDependencyScopes(
  entry: CompiledExternalDependencyPlanEntry,
): CompiledExternalDependencyPlanEntry {
  return { ...entry, scopes: [] };
}

function externalDependencyVerificationKey(entry: CompiledExternalDependencyPlanEntry): string {
  return `${entry.id}\0${entry.semanticSha256}\0${entry.packages
    .map((pkg) => pkg.resolvedPackageRoot)
    .join("\0")}`;
}

function formatScope(scope: CompiledExternalDependencyScope): string {
  return scope.kind === "application"
    ? `application node "${scope.nodeId}"`
    : `extension "${scope.namespace}" on node "${scope.nodeId}"`;
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}
