/**
 * Stamps callbacks passed to authored `defineTool()` calls with durable replay
 * descriptors. Each callback body is hoisted into a module-suffix function and
 * the live callback is stamped with that function plus the lexical values its
 * body references; the session, scope, and resolver bind its identity at resolve time.
 */

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import {
  collectFreeVariables,
  collectPatternNames,
  extractParamNames,
  findEveImportAliases,
  findProperty,
  isAstNode,
  isFunction,
  readDefinerName,
  type DynamicToolAstNode as AstNode,
  walkNode,
} from "#internal/workflow-bundle/dynamic-tool-ast-references.js";

type CallbackPhase =
  | "labelComplete"
  | "labelDelta"
  | "labelStart"
  | "approvalKey"
  | "approvalRequest"
  | "approvalResponse"
  | "execute"
  | "toModelOutput"
  | "inputSchema"
  | "outputSchema";
type CallbackPropertyName =
  | "approvalKey"
  | "label"
  | "approval"
  | "execute"
  | "start"
  | "request"
  | "response"
  | "complete"
  | "delta"
  | "toModelOutput"
  | "inputSchema"
  | "outputSchema";

interface CallbackInfo {
  readonly body: string;
  /** Node whose free variables are the callback's lexical captures. */
  readonly captureNode: AstNode;
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
  workflowFunctions: ReadonlySet<string> = NO_WORKFLOW_FUNCTIONS,
): Promise<{ code: string } | null> {
  if (!source.includes("defineTool") && !source.includes("defineWorkflowTool")) return null;

  const ast = (await parseWithNitroRolldownAst(filename, source)) as AstNode;
  const defineToolAliases = findEveImportAliases(ast, ["defineTool", "defineWorkflowTool"]);
  if (defineToolAliases.size === 0) return null;

  const callbacks: CallbackInfo[] = [];
  walkForCallbacks(source, ast, callbacks, [], {
    defineToolAliases,
    workflowFunctions,
    durableSchemaAliases: findEveImportAliases(ast, ["defineDurableSchema"]),
  });
  return callbacks.length === 0 ? null : applyTransform(source, callbacks);
}

const NO_WORKFLOW_FUNCTIONS: ReadonlySet<string> = new Set();

interface WalkContext {
  readonly defineToolAliases: ReadonlySet<string>;
  readonly durableSchemaAliases: ReadonlySet<string>;
  /**
   * Top-level `"use workflow"` functions the directive transform already
   * hoisted and stubbed. A tool whose `execute` is one never runs as a
   * callback, so it keeps its identity and is not stamped.
   */
  readonly workflowFunctions: ReadonlySet<string>;
}

function walkForCallbacks(
  source: string,
  node: AstNode | null | undefined,
  results: CallbackInfo[],
  nestedScopes: readonly ScopeEntry[],
  context: WalkContext,
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
    walkForCallbacks(source, bodyNode, results, extended, context);
    return;
  }

  if (
    node.type === "CallExpression" &&
    context.defineToolAliases.has(readDefinerName(node.callee) ?? "") &&
    node.arguments?.length === 1 &&
    node.arguments[0]?.type === "ObjectExpression"
  ) {
    collectToolCallbacks(source, node.arguments[0], results, nestedScopes, context);
    return;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          walkForCallbacks(source, child, results, nestedScopes, context);
        }
      }
    } else if (isAstNode(value)) {
      walkForCallbacks(source, value, results, nestedScopes, context);
    }
  }
}

function isWorkflowExecute(property: AstNode | undefined, context: WalkContext): boolean {
  const value = property?.value as AstNode | undefined;
  return (
    value?.type === "Identifier" &&
    value.name !== undefined &&
    context.workflowFunctions.has(value.name)
  );
}

function collectToolCallbacks(
  source: string,
  tool: AstNode,
  results: CallbackInfo[],
  nestedScopes: readonly ScopeEntry[],
  context: WalkContext,
): void {
  const execute = findProperty(tool, "execute");
  if (!isWorkflowExecute(execute, context)) {
    collectCallbackProperty(source, execute, "execute", "execute", results, nestedScopes);
  }
  collectCallbackProperty(
    source,
    findProperty(tool, "approvalKey"),
    "approvalKey",
    "approvalKey",
    results,
    nestedScopes,
  );
  const label = findProperty(tool, "label");
  const labelValue = label?.value as AstNode | undefined;
  if (labelValue?.type === "ObjectExpression") {
    collectCallbackProperty(
      source,
      findProperty(labelValue, "start"),
      "labelStart",
      "start",
      results,
      nestedScopes,
    );
    collectCallbackProperty(
      source,
      findProperty(labelValue, "complete"),
      "labelComplete",
      "complete",
      results,
      nestedScopes,
    );
    collectCallbackProperty(
      source,
      findProperty(labelValue, "delta"),
      "labelDelta",
      "delta",
      results,
      nestedScopes,
    );
  }
  collectCallbackProperty(
    source,
    findProperty(tool, "toModelOutput"),
    "toModelOutput",
    "toModelOutput",
    results,
    nestedScopes,
  );

  for (const propertyName of ["inputSchema", "outputSchema"] as const) {
    const property = findProperty(tool, propertyName);
    const value = property?.value as AstNode | undefined;
    if (
      property?.start === undefined ||
      property.end === undefined ||
      value?.start === undefined ||
      value.end === undefined
    )
      continue;
    // JSON Schema literals are already durable data and need no factory.
    if (value.type === "ObjectExpression" && !findProperty(value, "~standard")) continue;
    if (
      value.type === "CallExpression" &&
      (value.callee?.name === "__eveDefineDurableSchema" ||
        context.durableSchemaAliases.has(readDefinerName(value.callee) ?? ""))
    )
      continue;
    results.push({
      body: `{ return ${source.slice(value.start, value.end)}; }`,
      captureNode: value,
      isAsync: false,
      isGenerator: false,
      isReference: false,
      nestedScopes,
      params: "",
      phase: propertyName,
      propertyName,
      propEnd: property.end,
      propStart: property.start,
    });
  }

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
    if (!value.body) return;
    results.push({
      body: extractFnBody(source, value),
      captureNode: value,
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
      captureNode: value,
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
    const freeNames = collectFreeVariables(callback.captureNode);
    const candidateVars = callback.nestedScopes.flatMap((scope) => [
      ...scope.params,
      ...scope.vars,
    ]);
    const allVars = dedupeShadowed(candidateVars).filter((name) => freeNames.has(name));
    const closure = allVars.length > 0 ? `{ ${allVars.join(", ")} }` : "{}";
    const safePhase = callback.phase.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const hoistedName =
      callback.phase === "execute"
        ? `__eve_dynamic_exec_${index}`
        : `__eve_dynamic_${safePhase}_${index}`;
    // Captures are free in the callback, so they never collide with its own
    // parameters, and destructuring them first keeps them visible to defaults.
    const hoistedParams = [allVars.length > 0 ? closure : "__vars", callback.params]
      .filter(Boolean)
      .join(", ");
    const bodyContent = callback.body.slice(1, -1).trim();
    const asyncPrefix = callback.isAsync ? "async " : "";
    const generatorStar = callback.isGenerator ? "*" : "";

    hoistedFunctions.push(
      `${asyncPrefix}function${generatorStar} ${hoistedName}(${hoistedParams}) {\n` +
        `  ${bodyContent}\n` +
        `}`,
    );

    const wrapper = createLiveWrapper(callback, hoistedName, closure);
    const stamped =
      callback.phase === "inputSchema" || callback.phase === "outputSchema"
        ? `__eveDefineDurableSchema({ schema: ${hoistedName}, closure: ${closure} })`
        : `__eveStampDynamicCallback(${wrapper}, ${hoistedName}, ${closure})`;
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
    ...(callbacks.some(
      (callback) => callback.phase === "inputSchema" || callback.phase === "outputSchema",
    )
      ? ['import { defineDurableSchema as __eveDefineDurableSchema } from "eve/tools";']
      : []),
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
