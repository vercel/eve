import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  EXTENSION_CAPABILITY_VERSIONS,
  type ExtensionCapability,
  type ExtensionCapabilityRequirements,
} from "#compiler/extension-compatibility.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Derives only the extension-facing contracts used by one authored tree. */
export async function deriveExtensionCapabilityRequirements(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly manifest: AgentSourceManifest;
  readonly runtimeDependencies: readonly string[];
  readonly sourceRoot: string;
}): Promise<ExtensionCapabilityRequirements> {
  const required = new Set<ExtensionCapability>(["extension"]);
  const loadOptions = { externalDependencies: input.runtimeDependencies };
  const [tools, skills, instructions, declaration, usesState] = await Promise.all([
    Promise.all(
      input.manifest.tools.map((source) => compileToolEntry(input.sourceRoot, source, loadOptions)),
    ),
    Promise.all(
      input.manifest.skills.map((source) =>
        compileSkillSource(input.sourceRoot, source, loadOptions),
      ),
    ),
    Promise.all(
      input.manifest.instructions.map((source) =>
        compileInstructionsEntry(input.sourceRoot, source, loadOptions),
      ),
    ),
    loadAuthoredModuleNamespace(join(input.sourceRoot, input.declarationModule.logicalPath), {
      externalDependencies: input.runtimeDependencies,
    }),
    extensionUsesState(input.sourceRoot),
  ]);

  if (tools.length > 0) required.add("tool");
  if (tools.some((entry) => entry.kind === "dynamic-tool")) required.add("dynamicTool");
  if (input.manifest.connections.length > 0) required.add("connection");
  if (input.manifest.hooks.length > 0) required.add("hook");
  if (skills.length > 0) required.add("skill");
  if (skills.some((entry) => entry.kind === "dynamic-skill")) required.add("dynamicSkill");
  if (instructions.length > 0) required.add("instructions");
  if (instructions.some((entry) => entry.kind === "dynamic-instructions")) {
    required.add("dynamicInstructions");
  }
  const declarationExport = declaration[input.declarationModule.exportName ?? "default"];
  if (
    (typeof declarationExport === "function" ||
      (typeof declarationExport === "object" && declarationExport !== null)) &&
    "schema" in declarationExport &&
    declarationExport.schema !== undefined
  ) {
    required.add("config");
  }
  if (usesState) required.add("state");

  return Object.fromEntries(
    (Object.keys(EXTENSION_CAPABILITY_VERSIONS) as ExtensionCapability[])
      .filter((capability) => required.has(capability))
      .map((capability) => [capability, EXTENSION_CAPABILITY_VERSIONS[capability]]),
  );
}

interface CapabilityAstNode {
  readonly type?: string;
  readonly source?: { readonly value?: unknown };
  readonly specifiers?: readonly CapabilityAstNode[];
  readonly imported?: { readonly name?: unknown };
  readonly local?: { readonly name?: unknown };
  readonly callee?: CapabilityAstNode;
  readonly object?: CapabilityAstNode;
  readonly property?: { readonly name?: unknown };
  readonly name?: unknown;
  readonly [key: string]: unknown;
}

async function extensionUsesState(sourceRoot: string): Promise<boolean> {
  for (const modulePath of await collectAuthoredModules(sourceRoot)) {
    const source = await readFile(modulePath, "utf8");
    if (!source.includes("eve/context") || !source.includes("defineState")) continue;
    const ast = (await parseWithNitroRolldownAst(modulePath, source)) as CapabilityAstNode;
    if (astUsesImportedDefineState(ast)) return true;
  }
  return false;
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

function astUsesImportedDefineState(ast: CapabilityAstNode): boolean {
  const directBindings = new Set<string>();
  const namespaceBindings = new Set<string>();
  walkAst(ast, (node) => {
    if (node.type !== "ImportDeclaration" || node.source?.value !== "eve/context") return;
    for (const specifier of node.specifiers ?? []) {
      const localName = specifier.local?.name;
      if (typeof localName !== "string") continue;
      if (specifier.type === "ImportNamespaceSpecifier") namespaceBindings.add(localName);
      if (specifier.type === "ImportSpecifier" && specifier.imported?.name === "defineState") {
        directBindings.add(localName);
      }
    }
  });
  let used = false;
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee?.type === "Identifier" && typeof callee.name === "string") {
      used ||= directBindings.has(callee.name);
    } else if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      typeof callee.object.name === "string" &&
      namespaceBindings.has(callee.object.name) &&
      callee.property?.name === "defineState"
    ) {
      used = true;
    }
  });
  return used;
}

function walkAst(node: CapabilityAstNode, visitor: (node: CapabilityAstNode) => void): void {
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === "object" && child !== null && "type" in child) {
          walkAst(child as CapabilityAstNode, visitor);
        }
      }
    } else if (typeof value === "object" && value !== null && "type" in value) {
      walkAst(value as CapabilityAstNode, visitor);
    }
  }
}
