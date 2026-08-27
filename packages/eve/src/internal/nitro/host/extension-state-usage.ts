import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

const STATE_MODULE = "eve/context";
const STATE_EXPORT = "defineState";

/**
 * Detects whether an authored extension tree calls `defineState` from
 * `eve/context`. Usage is followed through local re-export barrels — aliased
 * re-exports, `export *`, and import-then-re-export chains — so indirect
 * usage still stamps the `state` capability requirement.
 */
export async function extensionUsesState(sourceRoot: string): Promise<boolean> {
  const modulePaths = await collectAuthoredModules(sourceRoot);
  const sources = new Map<string, string>();
  for (const modulePath of modulePaths) {
    sources.set(modulePath, await readFile(modulePath, "utf8"));
  }
  // A call site always names `defineState` (or a re-exported alias defined in
  // some local module), so a tree without the token cannot use state.
  if (![...sources.values()].some((source) => source.includes(STATE_EXPORT))) {
    return false;
  }

  const moduleSet = new Set(modulePaths);
  const shapes = new Map<string, ModuleStateShape>();
  for (const [modulePath, source] of sources) {
    const ast = (await parseWithNitroRolldownAst(modulePath, source)) as StateAstNode;
    shapes.set(modulePath, analyzeModule(ast));
  }

  const stateExports = computeStateExports(shapes, moduleSet);
  for (const [modulePath, shape] of shapes) {
    for (const [localName, binding] of shape.imports) {
      if (!shape.calledIdentifiers.has(localName)) continue;
      if (
        specifierExportsState({ ...binding, fromModulePath: modulePath, stateExports, moduleSet })
      ) {
        return true;
      }
    }
    for (const [localName, specifier] of shape.namespaceImports) {
      const calledProperties = shape.calledMembers.get(localName);
      if (calledProperties === undefined) continue;
      if (specifier === STATE_MODULE) {
        if (calledProperties.has(STATE_EXPORT)) return true;
        continue;
      }
      const provider = resolveLocalSpecifier(modulePath, specifier, moduleSet);
      const providerExports = provider === null ? undefined : stateExports.get(provider);
      if (
        providerExports !== undefined &&
        [...calledProperties].some((property) => providerExports.has(property))
      ) {
        return true;
      }
    }
  }
  return false;
}

interface StateAstNode {
  readonly type?: string;
  readonly source?: StateAstNode | null;
  readonly specifiers?: readonly StateAstNode[];
  readonly imported?: StateAstNode;
  readonly exported?: StateAstNode | null;
  readonly local?: StateAstNode;
  readonly callee?: StateAstNode;
  readonly object?: StateAstNode;
  readonly property?: StateAstNode;
  readonly name?: unknown;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

interface ModuleStateShape {
  /** Local binding → its import source, from `import { X as L } from "spec"`. */
  readonly imports: Map<string, { specifier: string; importedName: string }>;
  /** Local binding → specifier, from `import * as L from "spec"`. */
  readonly namespaceImports: Map<string, string>;
  /** Exported name → its origin, from `export { X as Y } from "spec"`. */
  readonly reexports: Map<string, { specifier: string; importedName: string }>;
  /** Specifiers of `export * from "spec"`. */
  readonly starReexportSpecifiers: string[];
  /** Exported name → local binding, from `export { L as Y }` without a source. */
  readonly localReexports: Map<string, string>;
  readonly calledIdentifiers: Set<string>;
  /** Namespace object name → member names it is called through. */
  readonly calledMembers: Map<string, Set<string>>;
}

async function collectAuthoredModules(directory: string): Promise<string[]> {
  const modules: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await collectAuthoredModules(path)));
    } else if (
      entry.isFile() &&
      !/\.d\.[cm]?ts$/.test(entry.name) &&
      SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    ) {
      modules.push(path);
    }
  }
  return modules.sort();
}

function analyzeModule(ast: StateAstNode): ModuleStateShape {
  const shape: ModuleStateShape = {
    imports: new Map(),
    namespaceImports: new Map(),
    reexports: new Map(),
    starReexportSpecifiers: [],
    localReexports: new Map(),
    calledIdentifiers: new Set(),
    calledMembers: new Map(),
  };
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      const specifier = stringValue(node.source);
      if (specifier === null) return;
      for (const entry of node.specifiers ?? []) {
        const localName = moduleName(entry.local);
        if (localName === null) continue;
        if (entry.type === "ImportNamespaceSpecifier") {
          shape.namespaceImports.set(localName, specifier);
        } else if (entry.type === "ImportSpecifier") {
          const importedName = moduleName(entry.imported);
          if (importedName !== null) shape.imports.set(localName, { specifier, importedName });
        }
      }
    } else if (node.type === "ExportNamedDeclaration") {
      const specifier = stringValue(node.source);
      for (const entry of node.specifiers ?? []) {
        if (entry.type !== "ExportSpecifier") continue;
        const localName = moduleName(entry.local);
        const exportedName = moduleName(entry.exported) ?? localName;
        if (localName === null || exportedName === null) continue;
        if (specifier !== null) {
          shape.reexports.set(exportedName, { specifier, importedName: localName });
        } else {
          shape.localReexports.set(exportedName, localName);
        }
      }
    } else if (node.type === "ExportAllDeclaration") {
      const specifier = stringValue(node.source);
      if (specifier !== null && node.exported == null) {
        shape.starReexportSpecifiers.push(specifier);
      }
    } else if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee?.type === "Identifier") {
        const name = moduleName(callee);
        if (name !== null) shape.calledIdentifiers.add(name);
      } else if (callee?.type === "MemberExpression" && callee.object?.type === "Identifier") {
        const objectName = moduleName(callee.object);
        const propertyName = moduleName(callee.property);
        if (objectName !== null && propertyName !== null) {
          const properties = shape.calledMembers.get(objectName) ?? new Set<string>();
          properties.add(propertyName);
          shape.calledMembers.set(objectName, properties);
        }
      }
    }
  });
  return shape;
}

/**
 * Fixpoint over local modules: which of each module's exports resolve back to
 * `eve/context`'s `defineState`, under whatever names the barrels chose.
 */
function computeStateExports(
  shapes: ReadonlyMap<string, ModuleStateShape>,
  moduleSet: ReadonlySet<string>,
): Map<string, Set<string>> {
  const stateExports = new Map<string, Set<string>>();
  for (const modulePath of shapes.keys()) stateExports.set(modulePath, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [modulePath, shape] of shapes) {
      const names = stateExports.get(modulePath)!;
      const add = (name: string): void => {
        if (!names.has(name)) {
          names.add(name);
          changed = true;
        }
      };
      for (const [exportedName, origin] of shape.reexports) {
        if (
          specifierExportsState({ ...origin, fromModulePath: modulePath, stateExports, moduleSet })
        ) {
          add(exportedName);
        }
      }
      for (const specifier of shape.starReexportSpecifiers) {
        if (specifier === STATE_MODULE) {
          add(STATE_EXPORT);
          continue;
        }
        const provider = resolveLocalSpecifier(modulePath, specifier, moduleSet);
        if (provider === null) continue;
        for (const name of stateExports.get(provider) ?? []) add(name);
      }
      for (const [exportedName, localName] of shape.localReexports) {
        const binding = shape.imports.get(localName);
        if (
          binding !== undefined &&
          specifierExportsState({ ...binding, fromModulePath: modulePath, stateExports, moduleSet })
        ) {
          add(exportedName);
        }
      }
    }
  }
  return stateExports;
}

function specifierExportsState(input: {
  readonly specifier: string;
  readonly importedName: string;
  readonly fromModulePath: string;
  readonly stateExports: ReadonlyMap<string, ReadonlySet<string>>;
  readonly moduleSet: ReadonlySet<string>;
}): boolean {
  if (input.specifier === STATE_MODULE) return input.importedName === STATE_EXPORT;
  const provider = resolveLocalSpecifier(input.fromModulePath, input.specifier, input.moduleSet);
  return provider !== null && (input.stateExports.get(provider)?.has(input.importedName) ?? false);
}

function resolveLocalSpecifier(
  fromModulePath: string,
  specifier: string,
  moduleSet: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromModulePath), specifier);
  const candidates = [base, ...emittedExtensionVariants(base)];
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    candidates.push(`${base}${extension}`, join(base, `index${extension}`));
  }
  return candidates.find((candidate) => moduleSet.has(candidate)) ?? null;
}

/** `./lib/eve.js` in nodenext-style source resolves to `lib/eve.ts` on disk. */
function emittedExtensionVariants(base: string): string[] {
  const swaps: readonly (readonly [string, string])[] = [
    [".js", ".ts"],
    [".jsx", ".tsx"],
    [".mjs", ".mts"],
    [".cjs", ".cts"],
  ];
  return swaps
    .filter(([emitted]) => base.endsWith(emitted))
    .map(([emitted, authored]) => base.slice(0, -emitted.length) + authored);
}

function moduleName(node: StateAstNode | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node.name === "string") return node.name;
  if (typeof node.value === "string") return node.value;
  return null;
}

function stringValue(node: StateAstNode | null | undefined): string | null {
  return typeof node?.value === "string" ? node.value : null;
}

function walkAst(node: StateAstNode, visitor: (node: StateAstNode) => void): void {
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === "object" && child !== null && "type" in child) {
          walkAst(child as StateAstNode, visitor);
        }
      }
    } else if (typeof value === "object" && value !== null && "type" in value) {
      walkAst(value as StateAstNode, visitor);
    }
  }
}
