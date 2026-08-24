/**
 * Stamps callbacks passed to authored `defineTool()` calls with durable replay
 * descriptors. Each callback body is hoisted into a module-suffix function and
 * the live callback is stamped with that function plus the lexical values its
 * body references; identity `(toolName, phase)` is assigned at resolve time.
 */

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import {
  collectReferencedIdentifierNames,
  findProperty,
  type DynamicToolAstNode as AstNode,
  walkNode,
} from "#internal/workflow-bundle/dynamic-tool-ast-references.js";

type CallbackPhase = "approvalRequest" | "approvalResponse" | "execute" | "toModelOutput";
type CallbackPropertyName = "approval" | "execute" | "request" | "response" | "toModelOutput";

interface CallbackInfo {
  readonly body: string;
  readonly bodyNode: AstNode;
  readonly isAsync: boolean;
  readonly isGenerator: boolean;
  readonly isReference: boolean;
  readonly nestedScopes: readonly ScopeEntry[];
  readonly params: string;
  readonly phase: CallbackPhase;
  readonly propertyName: CallbackPropertyName;
  readonly propEnd: number;
  readonly propStart: number;
}

interface ScopeEntry {
  readonly params: readonly string[];
  readonly vars: readonly string[];
}

/**
 * Transforms every `defineTool()` call imported from an eve authoring entry
 * point. This includes tools created in authored helper modules, not only the
 * file containing `defineDynamic()`.
 */
export async function transformDynamicToolExecute(
  filename: string,
  source: string,
): Promise<{ code: string } | null> {
  if (!source.includes("defineTool")) return null;

  const ast = (await parseWithNitroRolldownAst(filename, source)) as AstNode;
  const defineToolAliases = findDefineToolAliases(ast);
  if (defineToolAliases.size === 0) return null;

  const callbacks: CallbackInfo[] = [];
  walkForCallbacks(source, ast, callbacks, [], defineToolAliases);
  return callbacks.length === 0 ? null : applyTransform(source, callbacks);
}

function findDefineToolAliases(ast: AstNode): ReadonlySet<string> {
  const aliases = new Set<string>();
  walkNode(ast, (node) => {
    if (node.type !== "ImportDeclaration") return true;
    const source = node.source?.value;
    if (typeof source !== "string" || (source !== "eve" && !source.startsWith("eve/"))) {
      return false;
    }
    for (const specifier of node.specifiers ?? []) {
      if (
        specifier.type === "ImportSpecifier" &&
        (specifier.imported?.name ?? specifier.imported?.value) === "defineTool" &&
        specifier.local?.name
      ) {
        aliases.add(specifier.local.name);
      }
    }
    return false;
  });
  return aliases;
}

function walkForCallbacks(
  source: string,
  node: AstNode | null | undefined,
  results: CallbackInfo[],
  nestedScopes: readonly ScopeEntry[],
  defineToolAliases: ReadonlySet<string>,
): void {
  if (!node) return;

  if (isFunction(node)) {
    const bodyNode = node.body as AstNode | undefined;
    if (!bodyNode) return;
    const extended = [
      ...nestedScopes,
      {
        params: extractParamNames(node),
        vars: collectScopeVarDeclarations(bodyNode),
      },
    ];
    walkForCallbacks(source, bodyNode, results, extended, defineToolAliases);
    return;
  }

  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name !== undefined &&
    defineToolAliases.has(node.callee.name) &&
    node.arguments?.length === 1 &&
    node.arguments[0]?.type === "ObjectExpression"
  ) {
    collectToolCallbacks(source, node.arguments[0], results, nestedScopes);
    return;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          walkForCallbacks(source, child, results, nestedScopes, defineToolAliases);
        }
      }
    } else if (isAstNode(value)) {
      walkForCallbacks(source, value, results, nestedScopes, defineToolAliases);
    }
  }
}

function collectToolCallbacks(
  source: string,
  tool: AstNode,
  results: CallbackInfo[],
  nestedScopes: readonly ScopeEntry[],
): void {
  collectCallbackProperty(
    source,
    findProperty(tool, "execute"),
    "execute",
    "execute",
    results,
    nestedScopes,
  );
  collectCallbackProperty(
    source,
    findProperty(tool, "toModelOutput"),
    "toModelOutput",
    "toModelOutput",
    results,
    nestedScopes,
  );

  const approval = findProperty(tool, "approval");
  const approvalValue = approval?.value as AstNode | undefined;
  if (approvalValue?.type === "ObjectExpression") {
    collectCallbackProperty(
      source,
      findProperty(approvalValue, "request"),
      "approvalRequest",
      "request",
      results,
      nestedScopes,
    );
    collectCallbackProperty(
      source,
      findProperty(approvalValue, "response"),
      "approvalResponse",
      "response",
      results,
      nestedScopes,
    );
  } else {
    collectCallbackProperty(source, approval, "approvalRequest", "approval", results, nestedScopes);
  }
}

function collectCallbackProperty(
  source: string,
  property: AstNode | undefined,
  phase: CallbackPhase,
  propertyName: CallbackPropertyName,
  results: CallbackInfo[],
  nestedScopes: readonly ScopeEntry[],
): void {
  if (property?.type !== "Property" || property.start === undefined || property.end === undefined) {
    return;
  }
  const value = property.value as AstNode | undefined;
  if (!value || value.start === undefined || value.end === undefined) return;

  if (isFunction(value) || property.method === true) {
    const bodyNode = value.body as AstNode | undefined;
    if (!bodyNode) return;
    results.push({
      body: extractFnBody(source, value),
      bodyNode,
      isAsync: value.async === true,
      isGenerator: value.generator === true,
      isReference: false,
      nestedScopes,
      params: extractFnParams(source, value),
      phase,
      propertyName,
      propEnd: property.end,
      propStart: property.start,
    });
    return;
  }

  if (value.type === "Identifier") {
    results.push({
      body: `{ return ${source.slice(value.start, value.end)}(...__args); }`,
      bodyNode: value,
      isAsync: false,
      isGenerator: false,
      isReference: true,
      nestedScopes,
      params: "...__args",
      phase,
      propertyName,
      propEnd: property.end,
      propStart: property.start,
    });
  }
}

function applyTransform(source: string, callbacks: readonly CallbackInfo[]): { code: string } {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const hoistedFunctions: string[] = [];

  for (const [index, callback] of callbacks.entries()) {
    const referencedNames = collectReferencedIdentifierNames(callback.bodyNode);
    const candidateVars = callback.nestedScopes.flatMap((scope) => [
      ...scope.params,
      ...scope.vars,
    ]);
    const callbackParamNames = extractCallbackParamNames(callback.params);
    const allVars = dedupeShadowed(candidateVars).filter(
      (name) => !callbackParamNames.has(name) && referencedNames.has(name),
    );
    const closure = allVars.length > 0 ? `{ ${allVars.join(", ")} }` : "{}";
    const safePhase = callback.phase.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const hoistedName =
      callback.phase === "execute"
        ? `__eve_dynamic_exec_${index}`
        : `__eve_dynamic_${safePhase}_${index}`;
    const originalParams = callback.params;
    const hoistedParams = originalParams ? `__vars, ${originalParams}` : "__vars";
    const varsDestructure = allVars.length > 0 ? `const ${closure} = __vars;\n  ` : "";
    const bodyContent = callback.body.slice(1, -1).trim();
    const asyncPrefix = callback.isAsync ? "async " : "";
    const generatorStar = callback.isGenerator ? "*" : "";

    hoistedFunctions.push(
      `${asyncPrefix}function${generatorStar} ${hoistedName}(${hoistedParams}) {\n` +
        `  ${varsDestructure}${bodyContent}\n` +
        `}`,
    );

    const wrapper = createLiveWrapper(callback, hoistedName, closure);
    const stamped = `__eveStampDynamicCallback(${wrapper}, ${hoistedName}, ${closure})`;
    replacements.push({
      end: callback.propEnd,
      start: callback.propStart,
      text: `${callback.propertyName}: ${stamped}`,
    });
  }

  let code = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  }

  const registrySetup = [
    `var __eveDurableCallbackSym = Symbol.for("eve:durable-dynamic-callback");`,
    `function __eveStampDynamicCallback(callback, impl, closure) {`,
    `  Object.defineProperty(callback, __eveDurableCallbackSym, { configurable: true, value: { callback: impl, closure } });`,
    `  return callback;`,
    `}`,
  ].join("\n");
  return { code: `${registrySetup}\n${code}\n\n${hoistedFunctions.join("\n")}\n` };
}

function createLiveWrapper(callback: CallbackInfo, hoistedName: string, closure: string): string {
  if (callback.isReference) {
    return `(...__args) => ${hoistedName}(${closure}, ...__args)`;
  }
  const asyncPrefix = callback.isAsync ? "async " : "";
  if (callback.isGenerator) {
    return `${asyncPrefix}function* (...__args) { yield* ${hoistedName}(${closure}, ...__args); }`;
  }
  const awaitPrefix = callback.isAsync ? "await " : "";
  return `${asyncPrefix}(...__args) => ${awaitPrefix}${hoistedName}(${closure}, ...__args)`;
}

function dedupeShadowed(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let index = names.length - 1; index >= 0; index--) {
    const name = names[index]!;
    if (seen.has(name)) continue;
    seen.add(name);
    deduped.unshift(name);
  }
  return deduped;
}

function collectScopeVarDeclarations(bodyNode: AstNode): string[] {
  const names: string[] = [];
  walkNode(bodyNode, (node) => {
    if (node !== bodyNode && isFunction(node)) return false;
    if (node.type === "VariableDeclarator") collectPatternNames(node.id as AstNode | null, names);
    if (node.type === "FunctionDeclaration" && node.id?.name) names.push(node.id.name);
    return true;
  });
  return names;
}

function collectPatternNames(pattern: AstNode | null, names: string[]): void {
  if (!pattern) return;
  if (pattern.type === "Identifier" && pattern.name) {
    names.push(pattern.name);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      collectPatternNames(
        property.type === "RestElement"
          ? (property.argument as AstNode | null)
          : (property.value as AstNode | null),
        names,
      );
    }
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) collectPatternNames(element, names);
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternNames(pattern.left as AstNode | null, names);
  }
}

function extractParamNames(fn: AstNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params ?? []) collectPatternNames(parameter, names);
  return names;
}

function extractFnParams(source: string, fn: AstNode): string {
  if (!fn.params || fn.params.length === 0) return "";
  const first = fn.params[0]!;
  const last = fn.params[fn.params.length - 1]!;
  return first.start === undefined || last.end === undefined
    ? ""
    : source.slice(first.start, last.end);
}

function extractFnBody(source: string, fn: AstNode): string {
  const body = fn.body as AstNode | undefined;
  if (!body || body.start === undefined || body.end === undefined) return "{}";
  const raw = source.slice(body.start, body.end);
  return fn.type === "ArrowFunctionExpression" && body.type !== "BlockStatement"
    ? `{ return ${raw}; }`
    : raw;
}

function splitParamsTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (character === "<" || character === "(" || character === "[" || character === "{") {
      depth++;
    } else if (character === ">" || character === ")" || character === "]" || character === "}") {
      depth--;
    } else if (character === "," && depth === 0) {
      parts.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts;
}

function extractParamBindingName(parameter: string): string {
  const trimmed = parameter.trim();
  let depth = 0;
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!;
    if (character === "<" || character === "(" || character === "[" || character === "{") {
      depth++;
    } else if (character === ">" || character === ")" || character === "]" || character === "}") {
      depth--;
    } else if (depth === 0 && (character === ":" || character === "=")) {
      return trimmed.slice(0, index).trim();
    }
  }
  return trimmed;
}

function extractCallbackParamNames(params: string): Set<string> {
  const names: string[] = [];
  if (!params) return new Set();
  for (const parameter of splitParamsTopLevel(params)) {
    const binding = extractParamBindingName(parameter);
    if (binding.startsWith("...")) names.push(binding.slice(3));
    else names.push(binding);
  }
  return new Set(names);
}

function isFunction(node: AstNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}
