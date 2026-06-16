/**
 * Compiler transform for dynamic tool files.
 *
 * Hoists inline `execute` functions from `defineDynamic`
 * event handler return values to module-scope named functions
 * registered in the global step registry. The workflow SDK then
 * handles serialization and replay.
 *
 * The walker enters nested functions (helpers, callbacks, IIFEs) so
 * patterns like `function buildTool(n) { return { execute() {} } }`
 * are supported. For each execute found, scope variables from every
 * enclosing function between the handler and the execute are
 * collected. Only variables the execute body actually references are
 * captured — this avoids TDZ errors from later declarations.
 *
 * At each call site the inline execute is replaced with:
 * - A wrapper that passes referenced scope values as `__vars`
 * - `__executeStepFn`: reference to the hoisted function
 * - `__closureVars`: snapshot for durable serialization
 *
 * Limitation: `execute` must be an inline function literal (function
 * expression, arrow, or method shorthand). Variable references
 * (`execute: myFn`) and call results (`execute: makeFn()`) are not
 * detected — the transform returns null and the tool works on the
 * first workflow step but is not replayable.
 */

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

type AstNode = {
  argument?: AstNode | null;
  arguments?: AstNode[];
  async?: boolean;
  body?: AstNode | AstNode[] | { body?: AstNode[]; type?: string; start?: number; end?: number };
  callee?: AstNode;
  computed?: boolean;
  declaration?: AstNode | null;
  declarations?: AstNode[];
  end?: number;
  expression?: AstNode | null;
  id?: { name?: string; start?: number; end?: number } | null;
  init?: AstNode | null;
  key?: AstNode | null;
  kind?: string;
  left?: AstNode | null;
  method?: boolean;
  name?: string;
  params?: AstNode[];
  properties?: AstNode[];
  right?: AstNode | null;
  start?: number;
  type?: string;
  value?: AstNode | unknown;
};

interface HandlerInfo {
  /** The handler function AST node */
  handlerNode: AstNode;
  /** Start of the handler function body (the `{`) */
  bodyStart: number;
  /** Collected variable names declared in the handler scope */
  scopeVars: readonly string[];
  /** Handler parameter names (event, ctx) */
  paramNames: readonly string[];
  /** Execute functions found inside the return value */
  executes: readonly ExecuteInfo[];
}

interface ExecuteInfo {
  /** Full property range (execute: function(...) { ... }) */
  propStart: number;
  propEnd: number;
  /** The function source (params + body) */
  fnSource: string;
  /** Whether the function is async */
  isAsync: boolean;
  /** Generated name for the hoisted function */
  hoistedName: string;
  /** Parameter source */
  params: string;
  /** Body source (block statement including braces) */
  body: string;
  /** Scope entries from nested functions between handler and this execute */
  nestedScopes: readonly ScopeEntry[];
}

interface ScopeEntry {
  readonly params: readonly string[];
  readonly vars: readonly string[];
}

let transformCounter = 0;

/**
 * Transforms a dynamic tool file:
 * 1. Hoists execute functions to module scope with "use step"
 * 2. Captures handler-scope variables via __vars parameter
 * 3. Adds "use step" to event handlers so the workflow SDK caches
 *    the handler's return value (resolver runs once per scope)
 *
 * Returns null if the file doesn't contain a dynamic tool pattern.
 */
export async function transformDynamicToolExecute(
  filename: string,
  source: string,
): Promise<{ code: string } | null> {
  if (!source.includes("defineDynamic")) {
    return null;
  }
  if (!source.includes("events")) {
    return null;
  }
  if (!source.includes("execute")) {
    return null;
  }

  const ast = await parseSource(filename, source);
  const handlers = findDynamicToolHandlers(source, ast);

  if (handlers.every((h) => h.executes.length === 0)) {
    return null;
  }

  return applyTransform(source, handlers);
}

// Keep the old export name for backward compatibility with the plugin
export { transformDynamicToolExecute as transformDynamicToolAwait };

async function parseSource(filename: string, source: string): Promise<AstNode> {
  return (await parseWithNitroRolldownAst(filename, source)) as AstNode;
}

// ---------------------------------------------------------------------------
// AST analysis
// ---------------------------------------------------------------------------

function findDynamicToolHandlers(source: string, ast: AstNode): HandlerInfo[] {
  const handlers: HandlerInfo[] = [];

  walkNode(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "defineDynamic" &&
      node.arguments?.length === 1
    ) {
      const arg = node.arguments[0]!;
      if (arg.type === "ObjectExpression") {
        const eventsProp = findProperty(arg, "events");
        if (eventsProp?.value && (eventsProp.value as AstNode).type === "ObjectExpression") {
          collectHandlers(source, eventsProp.value as AstNode, handlers);
        }
      }
      return false;
    }
    return true;
  });

  return handlers;
}

function collectHandlers(source: string, eventsObj: AstNode, handlers: HandlerInfo[]): void {
  for (const prop of eventsObj.properties ?? []) {
    if (prop.type !== "Property") continue;
    const handler = prop.value as AstNode | undefined;
    if (!handler) continue;

    if (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") {
      continue;
    }

    const bodyNode = handler.body as AstNode | undefined;
    if (!bodyNode) continue;

    const bodyStart = findBlockBodyStart(bodyNode);
    if (bodyStart === null) continue;

    const paramNames = extractParamNames(handler);
    const scopeVars = collectScopeVarDeclarations(bodyNode);
    const executes = findExecuteFunctions(source, bodyNode);

    if (executes.length > 0) {
      handlers.push({
        handlerNode: handler,
        bodyStart,
        scopeVars,
        paramNames,
        executes,
      });
    }
  }
}

function findBlockBodyStart(node: AstNode): number | null {
  if (node.type === "BlockStatement" && node.start !== undefined) {
    return node.start;
  }
  if (
    typeof node.body === "object" &&
    !Array.isArray(node.body) &&
    node.body?.type === "BlockStatement" &&
    node.body.start !== undefined
  ) {
    return node.body.start;
  }
  return null;
}

function extractParamNames(fn: AstNode): string[] {
  const names: string[] = [];
  for (const param of fn.params ?? []) {
    if (param.type === "Identifier" && param.name) {
      names.push(param.name);
    }
  }
  return names;
}

/**
 * Collects all variable declarations at the top level of a function
 * body (const, let, var). These are the potential closure variables
 * that execute functions might reference.
 */
function collectScopeVarDeclarations(bodyNode: AstNode): string[] {
  const vars: string[] = [];
  collectVarsRecursive(bodyNode, vars);
  return vars;
}

function collectVarsRecursive(node: AstNode | null | undefined, vars: string[]): void {
  if (!node) return;

  // Stop at function boundaries — don't capture execute-local vars
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration"
  ) {
    return;
  }

  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations ?? []) {
      collectDeclaredNames(decl, vars);
    }
  }

  // Also capture for-loop variable declarations (ForStatement.init,
  // ForInStatement.left, ForOfStatement.left)
  if (node.type === "ForStatement" && node.init) {
    collectVarsRecursive(node.init, vars);
  }
  const nodeAny = node as Record<string, unknown>;
  if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left) {
    collectVarsRecursive(node.left, vars);
  }

  // Recurse into child nodes
  if (Array.isArray(node.body)) {
    for (const child of node.body) collectVarsRecursive(child, vars);
  } else if (node.body && typeof node.body === "object" && "type" in node.body) {
    collectVarsRecursive(node.body as AstNode, vars);
  }
  if (node.declarations) {
    for (const decl of node.declarations) collectVarsRecursive(decl, vars);
  }
  if (node.expression) collectVarsRecursive(node.expression, vars);
  if (Array.isArray(nodeAny.consequent)) {
    for (const c of nodeAny.consequent) collectVarsRecursive(c as AstNode, vars);
  } else if (nodeAny.consequent) {
    collectVarsRecursive(nodeAny.consequent as AstNode, vars);
  }
  if (nodeAny.alternate) collectVarsRecursive(nodeAny.alternate as AstNode, vars);
  if (nodeAny.block) collectVarsRecursive(nodeAny.block as AstNode, vars);
  if (nodeAny.handler) collectVarsRecursive(nodeAny.handler as AstNode, vars);
  if (nodeAny.finalizer) collectVarsRecursive(nodeAny.finalizer as AstNode, vars);
  if (nodeAny.cases && Array.isArray(nodeAny.cases)) {
    for (const c of nodeAny.cases) collectVarsRecursive(c as AstNode, vars);
  }
}

function collectDeclaredNames(node: AstNode, names: string[]): void {
  if (node.type === "VariableDeclarator") {
    collectPatternNames(node.id as AstNode | null, names);
  }
}

function collectPatternNames(pattern: AstNode | null, names: string[]): void {
  if (!pattern) return;

  if (pattern.type === "Identifier" && pattern.name) {
    names.push(pattern.name);
    return;
  }

  // Destructured: const { a, b } = ...
  if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties ?? []) {
      if (prop.type === "Property") {
        collectPatternNames(prop.value as AstNode | null, names);
      } else if (prop.type === "RestElement") {
        collectPatternNames(prop.argument as AstNode | null, names);
      }
    }
  }

  // Destructured: const [a, b] = ...
  if (pattern.type === "ArrayPattern") {
    for (const el of (pattern as AstNode & { elements?: (AstNode | null)[] }).elements ?? []) {
      if (el) collectPatternNames(el, names);
    }
  }
}

/**
 * Finds execute function properties inside object expressions in the
 * handler's return value.
 */
function findExecuteFunctions(source: string, bodyNode: AstNode): ExecuteInfo[] {
  const results: ExecuteInfo[] = [];
  walkForExecuteProps(source, bodyNode, results, []);
  return results;
}

function walkForExecuteProps(
  source: string,
  node: AstNode | null | undefined,
  results: ExecuteInfo[],
  nestedScopes: readonly ScopeEntry[],
): void {
  if (!node) return;

  // When crossing a function boundary, collect the function's params
  // and body-level vars as a new scope entry, then continue walking
  // inside. This lets us hoist execute functions from helpers, .map()
  // callbacks, etc. — the wrapper captures all enclosing scope vars.
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration"
  ) {
    const fnParams = extractParamNames(node);
    const bodyNode = node.body as AstNode | undefined;
    if (!bodyNode) return;
    const fnVars = collectScopeVarDeclarations(bodyNode);
    const extended = [...nestedScopes, { params: fnParams, vars: fnVars }];
    // Walk into the function body with the extended scope chain
    if (bodyNode.type === "BlockStatement") {
      walkForExecuteProps(source, bodyNode, results, extended);
    } else {
      // Arrow with expression body: () => ({ execute() {} })
      walkForExecuteProps(source, bodyNode, results, extended);
    }
    return;
  }

  // Only match `execute` inside a `defineTool(...)` call — not on bare objects.
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "defineTool" &&
    node.arguments?.length === 1 &&
    (node.arguments[0] as AstNode).type === "ObjectExpression"
  ) {
    const toolArg = node.arguments[0] as AstNode;
    for (const prop of toolArg.properties ?? []) {
      if (
        prop.type === "Property" &&
        !prop.computed &&
        prop.key?.type === "Identifier" &&
        prop.key.name === "execute" &&
        prop.start !== undefined &&
        prop.end !== undefined
      ) {
        const fn = prop.value as AstNode;
        if (!fn || fn.start === undefined || fn.end === undefined) continue;

        const isFn = fn.type === "FunctionExpression" || fn.type === "ArrowFunctionExpression";
        const isMethod = prop.method === true;

        if (isFn || isMethod) {
          const params = extractFnParams(source, fn);
          const body = extractFnBody(source, fn);
          const isAsync = fn.async === true;

          results.push({
            propStart: prop.start,
            propEnd: prop.end,
            fnSource: source.slice(fn.start, fn.end),
            isAsync,
            params,
            body,
            hoistedName: `__eve_dynamic_exec_${transformCounter++}`,
            nestedScopes,
          });
        }
      }
    }
    // Don't recurse into defineTool() arguments again — we already processed them.
    return;
  }

  // Recurse into child nodes, threading the scope chain through
  const walk = (child: AstNode | null | undefined) =>
    walkForExecuteProps(source, child, results, nestedScopes);

  if (Array.isArray(node.body)) {
    for (const child of node.body) walk(child);
  } else if (node.body && typeof node.body === "object" && "type" in node.body) {
    walk(node.body as AstNode);
  }
  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.value && typeof prop.value === "object" && "type" in (prop.value as AstNode)) {
        walk(prop.value as AstNode);
      }
    }
  }
  if (node.callee) walk(node.callee);
  if (node.arguments) {
    for (const arg of node.arguments) walk(arg);
  }
  if (node.expression) walk(node.expression);
  if (node.argument) walk(node.argument);
  if (node.init) walk(node.init);
  if (node.left) walk(node.left);
  if (node.right) walk(node.right);
  if (node.declarations) {
    for (const decl of node.declarations) walk(decl);
  }
  const nodeAny = node as Record<string, unknown>;
  if (Array.isArray(nodeAny.consequent)) {
    for (const c of nodeAny.consequent) walk(c as AstNode);
  } else if (nodeAny.consequent) {
    walk(nodeAny.consequent as AstNode);
  }
  if (nodeAny.alternate) walk(nodeAny.alternate as AstNode);
  if (nodeAny.block) walk(nodeAny.block as AstNode);
  if (nodeAny.handler) walk(nodeAny.handler as AstNode);
  if (nodeAny.finalizer) walk(nodeAny.finalizer as AstNode);
  if (nodeAny.cases && Array.isArray(nodeAny.cases)) {
    for (const c of nodeAny.cases) walk(c as AstNode);
  }
}

function extractFnParams(source: string, fn: AstNode): string {
  if (!fn.params || fn.params.length === 0) return "";
  const first = fn.params[0]!;
  const last = fn.params[fn.params.length - 1]!;
  if (first.start === undefined || last.end === undefined) return "";
  return source.slice(first.start, last.end);
}

function extractFnBody(source: string, fn: AstNode): string {
  const body = fn.body as AstNode | undefined;
  if (!body || body.start === undefined || body.end === undefined) return "{}";
  const raw = source.slice(body.start, body.end);
  if (fn.type === "ArrowFunctionExpression" && body.type !== "BlockStatement") {
    return `{ return ${raw}; }`;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Transform application
// ---------------------------------------------------------------------------

function applyTransform(source: string, handlers: HandlerInfo[]): { code: string } {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const hoistedFunctions: string[] = [];
  const registrations: string[] = [];
  const allExecNames: string[] = [];

  for (const handler of handlers) {
    for (const exec of handler.executes) {
      // Build the full set of candidate vars: handler scope + nested scopes
      const candidateVars = [
        ...handler.paramNames,
        ...handler.scopeVars,
        ...exec.nestedScopes.flatMap((s) => [...s.params, ...s.vars]),
      ];

      // Deduplicate, keeping last occurrence (inner scope shadows outer)
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (let i = candidateVars.length - 1; i >= 0; i--) {
        if (!seen.has(candidateVars[i]!)) {
          seen.add(candidateVars[i]!);
          deduped.unshift(candidateVars[i]!);
        }
      }

      // Only capture vars the execute body actually references. This
      // avoids TDZ errors when the execute is inside a nested function
      // that runs before later handler-level declarations are initialized.
      const bodyText = exec.body;

      // Exclude names that collide with the execute function's own
      // parameters — the hoisted function already has those as formal
      // params, and a `const { name } = __vars` would be a duplicate
      // binding SyntaxError.
      const execParamNames = extractExecuteParamNames(exec.params);

      const allVars = deduped.filter(
        (name) =>
          !execParamNames.has(name) && new RegExp(`\\b${escapeForRegex(name)}\\b`).test(bodyText),
      );

      const varsObj = allVars.length > 0 ? `{ ${allVars.join(", ")} }` : "{}";

      const asyncPrefix = exec.isAsync ? "async " : "";
      const varsDestructure = allVars.length > 0 ? `const ${varsObj} = __vars;\n  ` : "";
      const originalParams = exec.params;
      const hoistedParams = originalParams ? `__vars, ${originalParams}` : "__vars";
      const bodyContent = exec.body.slice(1, -1).trim();
      const stepId = `eve:dynamic-tool//${exec.hoistedName}`;

      hoistedFunctions.push(
        `${asyncPrefix}function ${exec.hoistedName}(${hoistedParams}) {\n` +
          `  ${varsDestructure}${bodyContent}\n` +
          `}`,
      );

      registrations.push(`${exec.hoistedName}.stepId = ${JSON.stringify(stepId)};`);
      registrations.push(`__eveStepRegistry.set(${JSON.stringify(stepId)}, ${exec.hoistedName});`);
      allExecNames.push(exec.hoistedName);

      const wrapperParams = originalParams || "";
      const paramNames = originalParams
        ? splitParamsTopLevel(originalParams)
            .map((p) => extractParamBindingName(p))
            .join(", ")
        : "";
      const wrapperArgs = paramNames ? `${varsObj}, ${paramNames}` : varsObj;
      const wrapperAsync = exec.isAsync ? "async " : "";
      const wrapperAwait = exec.isAsync ? "await " : "";

      replacements.push({
        start: exec.propStart,
        end: exec.propEnd,
        text: [
          `execute: ${wrapperAsync}(${wrapperParams}) => ${wrapperAwait}${exec.hoistedName}(${wrapperArgs})`,
          `__executeStepFn: ${exec.hoistedName}`,
          `__closureVars: ${varsObj}`,
        ].join(",\n          "),
      });
    }
  }

  const sorted = [...replacements].sort((a, b) => b.start - a.start);

  let result = source;

  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  // Prepend global step registry access — use var + if for
  // compatibility with all bundler output modes.
  const registrySetup = [
    `var __eveStepRegistrySym = Symbol.for("@workflow/core//registeredSteps");`,
    `if (!globalThis[__eveStepRegistrySym]) globalThis[__eveStepRegistrySym] = new Map();`,
    `var __eveStepRegistry = globalThis[__eveStepRegistrySym];`,
  ].join("\n");
  result = `${registrySetup}\n${result}`;

  // Append hoisted functions + registrations
  const suffix = [...hoistedFunctions, ...registrations];
  if (suffix.length > 0) {
    result = `${result}\n\n${suffix.join("\n")}\n`;
  }

  return { code: result };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkNode(node: AstNode, visitor: (node: AstNode) => boolean): void {
  if (!visitor(node)) return;

  if (Array.isArray(node.body)) {
    for (const child of node.body) walkNode(child, visitor);
  } else if (node.body && typeof node.body === "object" && "type" in node.body) {
    walkNode(node.body as AstNode, visitor);
  }
  if (node.declarations) {
    for (const decl of node.declarations) walkNode(decl, visitor);
  }
  if (node.init) walkNode(node.init, visitor);
  if (node.expression) walkNode(node.expression, visitor);
  if (node.declaration) walkNode(node.declaration, visitor);
  if (node.argument) walkNode(node.argument, visitor);
  if (node.arguments) {
    for (const arg of node.arguments) walkNode(arg, visitor);
  }
  if (node.properties) {
    for (const prop of node.properties) {
      walkNode(prop, visitor);
      if (prop.value && typeof prop.value === "object" && "type" in (prop.value as AstNode)) {
        walkNode(prop.value as AstNode, visitor);
      }
    }
  }
  if (node.left) walkNode(node.left, visitor);
  if (node.right) walkNode(node.right, visitor);
}

function findProperty(obj: AstNode, name: string): AstNode | undefined {
  return obj.properties?.find(
    (p) =>
      p.type === "Property" && !p.computed && p.key?.type === "Identifier" && p.key.name === name,
  );
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits a parameter string on top-level commas, respecting nested
 * angle brackets (`<>`), parentheses, square brackets, and curly
 * braces. Commas inside `Record<string, unknown>` or
 * `import("...").Foo` are not treated as parameter separators.
 */
function splitParamsTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts;
}

/**
 * Extracts the runtime binding name from a single parameter string
 * like `input`, `_input: Record<string, unknown>`, or `{ msg }`.
 * Strips type annotations (after top-level `:`) and defaults
 * (after top-level `=`).
 */
function extractParamBindingName(param: string): string {
  const trimmed = param.trim();
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && (ch === ":" || ch === "=")) {
      return trimmed.slice(0, i).trim();
    }
  }
  return trimmed;
}

/**
 * Extracts binding names from a raw execute parameter string.
 */
function extractExecuteParamNames(paramString: string): Set<string> {
  if (!paramString) return new Set();
  const names = new Set<string>();
  for (const part of splitParamsTopLevel(paramString)) {
    const name = extractParamBindingName(part);
    if (name) names.add(name);
  }
  return names;
}
