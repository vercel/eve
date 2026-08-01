import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import type { DynamicToolAstNode as AstNode } from "#internal/workflow-bundle/dynamic-tool-ast-references.js";

interface CredentialsFactoryInfo {
  readonly authPropertySource?: string;
  readonly callEnd: number;
  readonly callSource: string;
  readonly callStart: number;
  readonly headersPropertySource?: string;
  readonly hoistedName: string;
}

let transformCounter = 0;

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
  const factories = findCredentialsFactories(source, ast);
  return factories.length === 0 ? null : applyTransform(source, factories);
}

function findCredentialsFactories(source: string, ast: AstNode): CredentialsFactoryInfo[] {
  const factories: CredentialsFactoryInfo[] = [];

  walkNode(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      node.callee.name !== "defineRemoteAgent" ||
      node.arguments?.length !== 1 ||
      node.start === undefined ||
      node.end === undefined
    ) {
      return true;
    }
    const argument = node.arguments[0]!;
    if (argument.type !== "ObjectExpression") {
      return false;
    }
    const auth = findProperty(argument, "auth");
    const headers = findProperty(argument, "headers");
    if (auth === undefined && headers === undefined) {
      return false;
    }
    factories.push({
      authPropertySource: sliceNode(source, auth),
      callEnd: node.end,
      callSource: source.slice(node.start, node.end),
      callStart: node.start,
      headersPropertySource: sliceNode(source, headers),
      hoistedName: `__eve_dynamic_remote_credentials_${transformCounter++}`,
    });
    return false;
  });

  return factories;
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

  for (const credentials of factories) {
    const properties = [credentials.authPropertySource, credentials.headersPropertySource].filter(
      (property) => property !== undefined,
    );
    const stepId = `eve:dynamic-remote-agent//${credentials.hoistedName}`;
    hoistedFunctions.push(
      `function ${credentials.hoistedName}() {\n` +
        `  return { ${properties.join(", ")} };\n` +
        `}`,
    );
    registrations.push(`${credentials.hoistedName}.stepId = ${JSON.stringify(stepId)};`);
    registrations.push(
      `__eveStepRegistry.set(${JSON.stringify(stepId)}, ${credentials.hoistedName});`,
    );
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

function findProperty(object: AstNode, name: string): AstNode | undefined {
  return object.properties?.find(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      (property.key?.type === "Identifier"
        ? property.key.name === name
        : property.key?.value === name),
  );
}

function walkNode(node: AstNode, visitor: (node: AstNode) => boolean): void {
  if (!visitor(node)) return;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) walkNode(child, visitor);
      }
    } else if (isAstNode(value)) {
      walkNode(value, visitor);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}
