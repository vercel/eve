import {
  mayContainWorkflowDirective,
  readWorkflowDirective,
} from "#internal/workflow-bundle/workflow-directive-ast.js";
import { parseWorkflowSourceAst } from "#internal/workflow-bundle/workflow-source-ast.js";
import { WORKFLOW_TOOL_ENTRY_POINTS } from "#tools/workflow-entry-point.js";

// Built when an error needs it: the first `Intl` formatter in a process loads locale data, which
// would otherwise add to every cold start.
function formatEntryPointMethods(): string {
  return new Intl.ListFormat("en", { type: "disjunction" }).format(
    WORKFLOW_TOOL_ENTRY_POINTS.map((name) => `"${name}"`),
  );
}

// Earlier eve releases exported these helpers from `eve/workflow`; name the replacement instead
// of surfacing a generic missing-export error.
const REMOVED_WORKFLOW_HELPERS = new Set(["agent", "ask"]);

type AstNode = {
  readonly async?: boolean;
  readonly generator?: boolean;
  readonly body?: AstNode | readonly AstNode[] | null;
  readonly computed?: boolean;
  readonly declaration?: AstNode | null;
  readonly declarations?: readonly AstNode[];
  readonly directive?: string;
  readonly end?: number;
  readonly expression?: AstNode | boolean | null;
  readonly id?: AstNode | null;
  readonly imported?: AstNode | null;
  readonly init?: AstNode | null;
  readonly key?: AstNode | null;
  readonly kind?: string;
  readonly local?: AstNode | null;
  readonly method?: boolean;
  readonly name?: string;
  readonly object?: AstNode;
  readonly params?: readonly AstNode[];
  readonly properties?: readonly AstNode[];
  readonly property?: AstNode;
  readonly returnType?: AstNode | null;
  readonly specifiers?: readonly AstNode[];
  readonly start?: number;
  readonly type?: string;
  readonly typeParameters?: AstNode | null;
  readonly value?: unknown;
  readonly arguments?: readonly AstNode[];
  readonly callee?: AstNode;
  readonly source?: AstNode;
};

type AstProgram = { readonly body?: readonly AstNode[] };

interface DirectiveFunctionNode {
  readonly directive: string;
  readonly fn: AstNode;
}

/** A workflow tool's inline entry-point method: its property and function. */
interface EntryPointMethod {
  readonly fn: AstNode;
  /** The top-level function eve hoists the method to. */
  readonly hoistedName: string;
  readonly name: string;
  /** Whose method it is, for errors: `the default export` or `"escalate"`. */
  readonly owner: string;
  readonly property: AstNode;
}

export interface AuthoredWorkflowDirectiveSource {
  readonly hasDirectives: boolean;
  readonly hasWorkflowDirective: boolean;
  readonly source: string;
}

/**
 * The directive transform understands one shape: a top-level `async function`
 * whose first statement is the directive. A marked `defineWorkflowTool` entry
 * point (`execute` or `task`) is hoisted into that shape here; every other
 * placement is a build error, because an ignored directive would run side
 * effects inline in a replayed body.
 */
export async function prepareAuthoredWorkflowDirectives(input: {
  readonly filePath: string;
  readonly source: string;
}): Promise<AuthoredWorkflowDirectiveSource> {
  if (
    !mayContainWorkflowDirective(input.source) &&
    !input.source.includes("workflow") &&
    !input.source.includes("defineWorkflowTool")
  ) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  const parsePath = /\.[cm]?js$/.test(input.filePath) ? `${input.filePath}.jsx` : input.filePath;
  const program = (await parseWorkflowSourceAst(parsePath, input.source)) as AstProgram;
  const body = program.body ?? [];
  visit(program as AstNode, (node) => {
    const specifier =
      node.source?.value ??
      (node.type === "CallExpression" && node.callee?.name === "require"
        ? node.arguments?.[0]?.value
        : undefined);
    if (specifier === "eve/workflow") {
      const removed = node.specifiers?.find(isRemovedWorkflowHelper);
      if (removed !== undefined) {
        throw new Error(
          `${input.filePath}: "${specifierName(removed)}" is no longer exported from "eve/workflow". ` +
            'Use defineWorkflowTool() from "eve/tools" and call ctx.agent(target, input) or ctx.ask(request) in its executor.',
        );
      }
    }
    if (
      typeof specifier === "string" &&
      (specifier === "workflow" || specifier.startsWith("workflow/"))
    ) {
      throw new Error(
        `${input.filePath}: Import from \`eve/workflow\` (or \`eve/workflow/api\`) instead of "${specifier}". ` +
          "Only documented exports are supported; other Workflow SDK subpaths and exports are not public eve APIs.",
      );
    }
  });
  for (const statement of body) {
    if (typeof statement.directive !== "string") break;
    const directive = readWorkflowDirective(statement);
    if (directive !== undefined) {
      throw new Error(
        `${JSON.stringify(directive)} in "${input.filePath}" is a module-level directive. ` +
          `Put it as the first statement of the function it marks: a top-level "async function" declaration` +
          ` or the ${formatEntryPointMethods()} method of a default-exported defineWorkflowTool().`,
      );
    }
  }

  const allowed = new Set<AstNode>();
  for (const statement of body) {
    const declaration =
      statement.type === "FunctionDeclaration"
        ? statement
        : statement.type === "ExportNamedDeclaration" &&
            statement.declaration?.type === "FunctionDeclaration"
          ? statement.declaration
          : undefined;
    if (declaration !== undefined) allowed.add(declaration);
  }

  const definers = workflowToolDefiners(body);
  const entryPoints = [
    ...findDefaultExportEntryPoints(body),
    ...findTopLevelToolEntryPoints(body, definers),
  ];
  for (const entryPoint of entryPoints) {
    allowed.add(entryPoint.fn);
  }

  assertWorkflowToolEntryPoints(input.filePath, body, program as AstNode, definers);

  const found = collectDirectiveFunctions(program as AstNode);
  if (found.length === 0) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  const hasWorkflowDirective = found.some((entry) => entry.directive === "use workflow");
  for (const entry of found) {
    if (!allowed.has(entry.fn)) {
      const nested = nestedToolEntryPoint(program as AstNode, definers, entry.fn);
      if (nested !== undefined) {
        throw new Error(
          `${JSON.stringify(entry.directive)} in "${input.filePath}" marks the "${nested}" of a defineWorkflowTool() that isn't declared at the top level of the module, such as one created inside defineDynamic(). ` +
            `A workflow can't read the variables around it, so eve can only compile it at the top level: assign the defineWorkflowTool() to a top-level const, and return that const from defineDynamic().`,
        );
      }
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}. ` +
          `Workflow directives must mark a top-level "async function" declaration` +
          ` or the ${formatEntryPointMethods()} method of a defineWorkflowTool() that is the default export or a top-level const.`,
      );
    }
    if (entry.fn.async !== true) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}, which is not async. ` +
          `Declare it with "async function".`,
      );
    }
    const entryPoint = entryPoints.find((candidate) => candidate.fn === entry.fn);
    if (entryPoint !== undefined && entry.directive !== "use workflow") {
      throw new Error(
        `"use step" in "${input.filePath}" marks ${entryPoint.owner}'s "${entryPoint.name}" method. ` +
          `A tool's "${entryPoint.name}" can be a workflow ("use workflow"); steps are the helper functions it calls.`,
      );
    }
  }

  // defineWorkflowTool() accepts one entry point, so each tool hoists at most one.
  const hoisted = entryPoints.filter((entryPoint) =>
    found.some((entry) => entry.fn === entryPoint.fn),
  );
  if (hoisted.length === 0) {
    return {
      hasDirectives: true,
      hasWorkflowDirective,
      source: input.source,
    };
  }

  for (const method of hoisted) {
    if (declaresTopLevelBinding(body, method.hoistedName)) {
      throw new Error(
        `"use workflow" in "${input.filePath}" marks the "${method.name}" method, but the module also declares a top-level "${method.hoistedName}" binding. ` +
          `eve hoists that method to a top-level "async function ${method.hoistedName}"; rename the existing binding.`,
      );
    }
  }

  return {
    hasDirectives: true,
    hasWorkflowDirective,
    source: hoistEntryPointMethods(input.source, hoisted),
  };
}

/**
 * The build compiles a default-exported workflow tool and checks its entry point. Any other
 * `defineWorkflowTool()`, such as one a `defineDynamic()` returns, is only checked when the tool is
 * offered, so its entry point is checked here: an inline function, or a top-level one the module
 * declares, must start with "use workflow". An imported entry point is left to that later check.
 */
function assertWorkflowToolEntryPoints(
  filePath: string,
  body: readonly AstNode[],
  program: AstNode,
  definers: WorkflowToolDefiners,
): void {
  if (definers.names.size === 0 && definers.namespaces.size === 0) return;
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  visit(program, (node) => {
    if (node.type !== "CallExpression" || node === exported?.declaration) return;
    if (!isWorkflowToolDefiner(node.callee, definers)) return;
    const definition = node.arguments?.[0];
    if (definition?.type !== "ObjectExpression") return;
    for (const property of definition.properties ?? []) {
      if (property.type !== "Property" || property.computed === true) continue;
      const name = readPropertyName(property.key);
      if (name === undefined || !WORKFLOW_TOOL_ENTRY_POINTS.some((entry) => entry === name)) {
        continue;
      }
      const value = unwrapExpression(property.value);
      const fn = localFunction(body, value);
      if (fn === undefined) continue;
      const directive = readLeadingDirective(fn);
      // An inline method's directive is checked where it sits, with the module's other directives.
      if (directive === "use workflow" || (directive !== undefined && fn === value)) continue;
      throw new Error(
        `The "${name}" of a defineWorkflowTool() in "${filePath}" is ${fn.type === "FunctionDeclaration" ? `the function "${fn.id?.name}"` : describeFunction(fn)} without "use workflow", so it can't run as a workflow. ` +
          `Declare it as a top-level "async function" that starts with "use workflow", and pass that function as "${name}".`,
      );
    }
  });
}

interface WorkflowToolDefiners {
  readonly names: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

/** The local names `defineWorkflowTool` is imported under, directly or through a namespace. */
function workflowToolDefiners(body: readonly AstNode[]): WorkflowToolDefiners {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source?.value;
    if (source !== "eve" && source !== "eve/tools") continue;
    for (const specifier of statement.specifiers ?? []) {
      const local = specifier.local?.name;
      if (local === undefined) continue;
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
      if (
        specifier.type === "ImportSpecifier" &&
        specifierName(specifier) === "defineWorkflowTool"
      ) {
        names.add(local);
      }
    }
  }
  return { names, namespaces };
}

function isWorkflowToolDefiner(
  callee: AstNode | undefined,
  definers: WorkflowToolDefiners,
): boolean {
  if (callee?.type === "Identifier") return definers.names.has(callee.name ?? "");
  if (callee?.type !== "MemberExpression" || callee.computed === true) return false;
  return (
    callee.object?.type === "Identifier" &&
    definers.namespaces.has(callee.object.name ?? "") &&
    readPropertyName(callee.property) === "defineWorkflowTool"
  );
}

/** The function an entry point is: inline, or a top-level declaration it names. */
function localFunction(body: readonly AstNode[], value: AstNode | undefined): AstNode | undefined {
  if (value === undefined) return undefined;
  if (isFunctionLike(value)) return value;
  if (value.type !== "Identifier") return undefined;
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration === null || declaration === undefined) continue;
    if (declaration.type === "FunctionDeclaration" && declaration.id?.name === value.name) {
      return declaration;
    }
    if (declaration.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.name !== value.name) continue;
      const init = unwrapExpression(declarator.init);
      return init !== undefined && isFunctionLike(init) ? init : undefined;
    }
  }
  return undefined;
}

/** Looks through type assertions and parentheses, which don't change the value. */
function unwrapExpression(value: unknown): AstNode | undefined {
  let node = isAstNode(value) ? value : undefined;
  while (
    node !== undefined &&
    (node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression")
  ) {
    node = isAstNode(node.expression) ? node.expression : undefined;
  }
  return node;
}

function findDefaultExportEntryPoints(body: readonly AstNode[]): EntryPointMethod[] {
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const declaration = exported?.declaration;
  const definition =
    declaration?.type === "CallExpression" ? declaration.arguments?.[0] : declaration;
  return inlineEntryPoints(definition ?? undefined, "the default export", (name) => name);
}

/**
 * A `defineWorkflowTool()` a top-level const holds, so a `defineDynamic()` can return it. Its
 * method hoists to a function named after the const, which keeps two tools in one module apart.
 */
function findTopLevelToolEntryPoints(
  body: readonly AstNode[],
  definers: WorkflowToolDefiners,
): EntryPointMethod[] {
  const methods: EntryPointMethod[] = [];
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations ?? []) {
      const binding = declarator.id?.type === "Identifier" ? declarator.id.name : undefined;
      const call = unwrapExpression(declarator.init);
      if (binding === undefined || call?.type !== "CallExpression") continue;
      if (!isWorkflowToolDefiner(call.callee, definers)) continue;
      methods.push(
        ...inlineEntryPoints(call.arguments?.[0], `"${binding}"`, (name) => `${binding}$${name}`),
      );
    }
  }
  return methods;
}

function inlineEntryPoints(
  definition: AstNode | undefined,
  owner: string,
  hoistedName: (name: string) => string,
): EntryPointMethod[] {
  if (definition?.type !== "ObjectExpression") return [];
  const methods: EntryPointMethod[] = [];
  for (const property of definition.properties ?? []) {
    if (property.type !== "Property" || property.kind !== "init" || property.computed === true) {
      continue;
    }
    const name = readPropertyName(property.key);
    const fn = property.value;
    if (name === undefined || !WORKFLOW_TOOL_ENTRY_POINTS.some((entry) => entry === name)) continue;
    if (!isAstNode(fn) || !isFunctionLike(fn)) continue;
    methods.push({ fn, hoistedName: hoistedName(name), name, owner, property });
  }
  return methods;
}

/** The entry point `fn` is, when it's inline in a `defineWorkflowTool()` eve doesn't hoist. */
function nestedToolEntryPoint(
  program: AstNode,
  definers: WorkflowToolDefiners,
  fn: AstNode,
): string | undefined {
  let found: string | undefined;
  visit(program, (node) => {
    if (found !== undefined || node.type !== "CallExpression") return;
    if (!isWorkflowToolDefiner(node.callee, definers)) return;
    const definition = node.arguments?.[0];
    if (definition?.type !== "ObjectExpression") return;
    for (const property of definition.properties ?? []) {
      if (property.type === "Property" && property.value === fn) {
        found = readPropertyName(property.key);
      }
    }
  });
  return found;
}

/** Hoists each method to a top-level declaration, rewriting from the end so ranges stay valid. */
function hoistEntryPointMethods(source: string, methods: readonly EntryPointMethod[]): string {
  const ordered = [...methods].sort((a, b) => (b.property.start ?? 0) - (a.property.start ?? 0));
  let rewritten = source;
  const declarations: string[] = [];
  for (const method of ordered) {
    const hoisted = hoistEntryPointMethod(rewritten, method);
    rewritten = hoisted.source;
    declarations.unshift(hoisted.declaration);
  }
  return `${rewritten}${declarations.map((declaration) => `\n${declaration}\n`).join("")}`;
}

function hoistEntryPointMethod(
  source: string,
  method: EntryPointMethod,
): { readonly declaration: string; readonly source: string } {
  const { fn, hoistedName, name, property } = method;
  if (
    property.start === undefined ||
    property.end === undefined ||
    !isAstNode(fn.body) ||
    fn.body.start === undefined ||
    fn.body.end === undefined
  ) {
    throw new Error(`Cannot hoist a "${name}" method without source ranges.`);
  }

  const params = fn.params ?? [];
  const first = params[0];
  const last = params[params.length - 1];
  const paramsText =
    first?.start === undefined || last?.end === undefined
      ? ""
      : source.slice(first.start, last.end);
  const typeParametersText = sliceNode(source, fn.typeParameters);
  const returnTypeText = sliceNode(source, fn.returnType);
  const bodyText = source.slice(fn.body.start, fn.body.end);
  const star = fn.generator === true ? "*" : "";
  const declaration = `async function${star} ${hoistedName}${typeParametersText}(${paramsText})${returnTypeText} ${bodyText}`;
  const reference = hoistedName === name ? name : `${name}: ${hoistedName}`;

  return {
    declaration,
    source: `${source.slice(0, property.start)}${reference}${source.slice(property.end)}`,
  };
}

function sliceNode(source: string, node: AstNode | null | undefined): string {
  if (node === null || node === undefined || node.start === undefined || node.end === undefined) {
    return "";
  }
  return source.slice(node.start, node.end);
}

function declaresTopLevelBinding(body: readonly AstNode[], name: string): boolean {
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration === null || declaration === undefined) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id?.name === name
    ) {
      return true;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        if (declarator.id?.name === name) return true;
      }
    }
    if (declaration.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers ?? []) {
        if (specifier.local?.name === name) return true;
      }
    }
  }
  return false;
}

function collectDirectiveFunctions(root: AstNode): DirectiveFunctionNode[] {
  const found: DirectiveFunctionNode[] = [];
  visit(root, (node) => {
    if (!isFunctionLike(node)) return;
    const directive = readLeadingDirective(node);
    if (directive !== undefined) found.push({ directive, fn: node });
  });
  return found;
}

function readLeadingDirective(fn: AstNode): string | undefined {
  if (!isAstNode(fn.body) || fn.body.type !== "BlockStatement" || !Array.isArray(fn.body.body)) {
    return undefined;
  }
  return readWorkflowDirective(fn.body.body[0]);
}

function describeFunction(fn: AstNode): string {
  if (fn.type === "FunctionDeclaration") {
    return fn.id?.name === undefined
      ? "a nested function declaration"
      : `the nested function "${fn.id.name}"`;
  }
  if (fn.type === "ArrowFunctionExpression") return "an arrow function";
  return fn.id?.name === undefined ? "a function expression" : `the function "${fn.id.name}"`;
}

function readPropertyName(key: AstNode | null | undefined): string | undefined {
  if (key === null || key === undefined) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function isFunctionLike(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** The source-module name of an import or re-export specifier. */
function specifierName(specifier: AstNode): unknown {
  const name = specifier.type === "ImportSpecifier" ? specifier.imported : specifier.local;
  return name?.name ?? name?.value;
}

function isRemovedWorkflowHelper(specifier: AstNode): boolean {
  if (specifier.type !== "ImportSpecifier" && specifier.type !== "ExportSpecifier") return false;
  const name = specifierName(specifier);
  return typeof name === "string" && REMOVED_WORKFLOW_HELPERS.has(name);
}

function visit(node: AstNode, visitor: (node: AstNode) => void): void {
  if (node.type?.startsWith("TS")) return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) visit(item, visitor);
      }
    } else if (isAstNode(value)) {
      visit(value, visitor);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}
