import { createHash } from "node:crypto";

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import {
  collectReferencedIdentifierNames,
  collectScopeVarDeclarations,
  extractParamNames,
  findEveImportAliases,
  findProperty,
  isAstNode,
  isFunction,
  readDefinerName,
  type DynamicToolAstNode as AstNode,
  walkNode,
} from "#internal/workflow-bundle/dynamic-tool-ast-references.js";
import { stableModuleId } from "#internal/workflow-bundle/stable-module-id.js";

interface CredentialsFactoryInfo {
  readonly authPropertySource?: string;
  readonly callEnd: number;
  readonly callSource: string;
  readonly callStart: number;
  readonly headersPropertySource?: string;
  readonly hoistedName: string;
}

/**
 * Hoists dynamic remote auth and headers into registered factories so durable
 * selections carry only a function id, never credential values or closures.
 */
export async function transformDynamicRemoteAgentCredentials(
  filename: string,
  source: string,
): Promise<{ code: string } | null> {
  if (
    !source.includes("defineDynamic") ||
    !source.includes("defineRemoteAgent") ||
    (!source.includes("auth") && !source.includes("headers"))
  ) {
    return null;
  }

  const ast = (await parseWithNitroRolldownAst(filename, source)) as AstNode;
  const factories = findCredentialsFactories(filename, source, ast);
  return factories.length === 0 ? null : applyTransform(source, factories);
}

function findCredentialsFactories(
  filename: string,
  source: string,
  ast: AstNode,
): CredentialsFactoryInfo[] {
  const factories: CredentialsFactoryInfo[] = [];
  const moduleId = stableModuleId(filename);
  const definers = findEveImportAliases(ast, ["defineRemoteAgent"]);

  const visit = (node: AstNode, enclosingBindings: ReadonlySet<string>): void => {
    if (isFunction(node)) {
      const body = node.body as AstNode | undefined;
      if (body === undefined) return;
      visit(
        body,
        new Set([
          ...enclosingBindings,
          ...extractParamNames(node),
          ...collectScopeVarDeclarations(body),
        ]),
      );
      return;
    }

    const argument = node.arguments?.[0];
    if (
      node.type === "CallExpression" &&
      definers.has(readDefinerName(node.callee) ?? "") &&
      node.arguments?.length === 1 &&
      argument?.type === "ObjectExpression" &&
      node.start !== undefined &&
      node.end !== undefined
    ) {
      const auth = findProperty(argument, "auth");
      const headers = findProperty(argument, "headers");
      if (auth !== undefined || headers !== undefined) {
        assertModuleScoped(filename, [auth, headers], enclosingBindings);
        // Content-addressed so the id survives rebuilds and never collides across
        // modules or transform order; editing the factory itself invalidates it.
        const callSource = source.slice(node.start, node.end);
        const hash = createHash("sha256")
          .update(`${moduleId}//${callSource}`)
          .digest("hex")
          .slice(0, 16);
        factories.push({
          authPropertySource: sliceNode(source, auth),
          callEnd: node.end,
          callSource,
          callStart: node.start,
          headersPropertySource: sliceNode(source, headers),
          hoistedName: `__eve_dynamic_remote_credentials_${hash}`,
        });
        return;
      }
    }

    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, enclosingBindings);
      }
    }
  };

  visit(ast, new Set());
  return factories;
}

/**
 * Hoisted credentials run at module scope, so a reference to a function-local
 * binding would throw or, when a module binding shares its name, silently
 * resolve to the wrong value.
 */
function assertModuleScoped(
  filename: string,
  properties: ReadonlyArray<AstNode | undefined>,
  enclosingBindings: ReadonlySet<string>,
): void {
  for (const property of properties) {
    const value = property?.value as AstNode | undefined;
    if (value === undefined) continue;
    const ownBindings = collectOwnBindings(value);
    const captured = [...collectReferencedIdentifierNames(value)].filter(
      (name) => enclosingBindings.has(name) && !ownBindings.has(name),
    );
    if (captured.length > 0) {
      const key = String(property!.key?.name ?? property!.key?.value);
      const names = captured.map((name) => `"${name}"`).join(", ");
      throw new Error(
        `Dynamic remote agent "${key}" in ${filename} references ${names}, declared inside a function. ` +
          `eve moves dynamic remote auth and headers to module scope so credentials stay out of durable workflow state. ` +
          `Declare ${names} at module scope or inside "${key}" itself.`,
      );
    }
  }
}

function collectOwnBindings(node: AstNode): Set<string> {
  const names = new Set<string>();
  walkNode(node, (current) => {
    if (isFunction(current)) {
      for (const name of extractParamNames(current)) names.add(name);
      const body = current.body as AstNode | undefined;
      if (body !== undefined) {
        for (const name of collectScopeVarDeclarations(body)) names.add(name);
      }
    }
    return true;
  });
  return names;
}

function applyTransform(
  source: string,
  factories: readonly CredentialsFactoryInfo[],
): {
  code: string;
} {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const hoistedFunctions: string[] = [];
  const registrations: string[] = [];

  // Byte-identical factories share one hoisted declaration so the emitted
  // module never declares the same top-level function twice.
  const emittedNames = new Set<string>();

  for (const credentials of factories) {
    const properties = [credentials.authPropertySource, credentials.headersPropertySource].filter(
      (property) => property !== undefined,
    );
    const stepId = `eve:dynamic-remote-agent//${credentials.hoistedName}`;
    if (!emittedNames.has(credentials.hoistedName)) {
      emittedNames.add(credentials.hoistedName);
      hoistedFunctions.push(
        `function ${credentials.hoistedName}() {\n` +
          `  return { ${properties.join(", ")} };\n` +
          `}`,
      );
      registrations.push(`${credentials.hoistedName}.stepId = ${JSON.stringify(stepId)};`);
      registrations.push(
        `__eveStepRegistry.set(${JSON.stringify(stepId)}, ${credentials.hoistedName});`,
      );
    }
    replacements.push({
      start: credentials.callStart,
      end: credentials.callEnd,
      text: `Object.defineProperty(${credentials.callSource}, "__eveResolveRemoteAgentCredentials", { value: ${credentials.hoistedName} })`,
    });
  }

  let code = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  }

  const registrySetup = [
    `var __eveStepRegistrySym = Symbol.for("@workflow/core//registeredSteps");`,
    `if (!globalThis[__eveStepRegistrySym]) globalThis[__eveStepRegistrySym] = new Map();`,
    `var __eveStepRegistry = globalThis[__eveStepRegistrySym];`,
  ].join("\n");
  return {
    code: `${registrySetup}\n${code}\n\n${[...hoistedFunctions, ...registrations].join("\n")}\n`,
  };
}

function sliceNode(source: string, node: AstNode | undefined): string | undefined {
  return node?.start === undefined || node.end === undefined
    ? undefined
    : source.slice(node.start, node.end);
}
