import { createHash } from "node:crypto";

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import {
  collectFreeVariables,
  findEveImportAliases,
  findProperty,
  type DynamicToolAstNode as AstNode,
  walkDefinerCalls,
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
  // The bare name also covers re-exports through authored modules.
  const definers = new Set([
    "defineRemoteAgent",
    ...findEveImportAliases(ast, ["defineRemoteAgent"]),
  ]);

  walkDefinerCalls(ast, definers, (call, argument, enclosingBindings) => {
    const auth = findProperty(argument, "auth");
    const headers = findProperty(argument, "headers");
    if (
      (auth === undefined && headers === undefined) ||
      call.start === undefined ||
      call.end === undefined
    ) {
      return;
    }
    assertModuleScoped(filename, [auth, headers], enclosingBindings);
    // Content-addressed so the id survives rebuilds and never collides across
    // modules or transform order; editing the factory itself invalidates it.
    const callSource = source.slice(call.start, call.end);
    const hash = createHash("sha256")
      .update(`${moduleId}//${callSource}`)
      .digest("hex")
      .slice(0, 16);
    factories.push({
      authPropertySource: sliceNode(source, auth),
      callEnd: call.end,
      callSource,
      callStart: call.start,
      headersPropertySource: sliceNode(source, headers),
      hoistedName: `__eve_dynamic_remote_credentials_${hash}`,
    });
  });

  return factories;
}

/**
 * Hoisted credentials run at module scope, so a reference to a binding from an
 * enclosing function or block would throw or, when a module binding shares its
 * name, silently resolve to the wrong value.
 */
function assertModuleScoped(
  filename: string,
  properties: ReadonlyArray<AstNode | undefined>,
  enclosingBindings: ReadonlySet<string>,
): void {
  for (const property of properties) {
    const value = property?.value as AstNode | undefined;
    if (value === undefined) continue;
    const captured = [...collectFreeVariables(value)].filter((name) => enclosingBindings.has(name));
    if (captured.length > 0) {
      const key = String(property!.key?.name ?? property!.key?.value);
      const names = captured.map((name) => `"${name}"`).join(", ");
      throw new Error(
        `Dynamic remote agent "${key}" in ${filename} references ${names}, declared outside module scope. ` +
          `eve moves dynamic remote auth and headers to module scope so credentials stay out of durable workflow state. ` +
          `Declare ${names} at module scope or inside "${key}" itself.`,
      );
    }
  }
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
