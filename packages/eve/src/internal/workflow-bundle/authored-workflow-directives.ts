import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import {
  mayContainWorkflowDirective,
  readWorkflowDirective,
} from "#internal/workflow-bundle/workflow-directive-ast.js";
import { WORKFLOW_TOOL_ENTRY_POINTS } from "#tools/workflow-entry-point.js";

const ENTRY_POINT_METHODS = WORKFLOW_TOOL_ENTRY_POINTS.map((name) => `"${name}"`).join(" or ");

type AstNode = {
  async?: boolean;
  generator?: boolean;
  body?: AstNode | AstNode[] | null;
  computed?: boolean;
  declaration?: AstNode | null;
  declarations?: AstNode[];
  directive?: string;
  end?: number;
  expression?: AstNode | boolean | null;
  id?: AstNode | null;
  key?: AstNode | null;
  kind?: string;
  local?: AstNode | null;
  method?: boolean;
  name?: string;
  params?: AstNode[];
  properties?: AstNode[];
  returnType?: AstNode | null;
  specifiers?: AstNode[];
  start?: number;
  type?: string;
  typeParameters?: AstNode | null;
  value?: unknown;
  arguments?: AstNode[];
  source?: AstNode;
};

type AstProgram = { body?: AstNode[] };

interface DirectiveFunctionNode {
  readonly directive: string;
  readonly fn: AstNode;
}

/** A default-exported definition's entry-point method: its property and function. */
interface EntryPointMethod {
  readonly fn: AstNode;
  readonly name: string;
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
  if (!mayContainWorkflowDirective(input.source) && !input.source.includes("eve/workflow")) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  const parsePath = /\.[cm]?js$/.test(input.filePath) ? `${input.filePath}.jsx` : input.filePath;
  const program = (await parseWithNitroRolldownAst(parsePath, input.source)) as AstProgram;
  const body = program.body ?? [];
  if (body.some((node) => node.source?.value === "eve/workflow")) {
    throw new Error(
      `${input.filePath}: "eve/workflow" has been removed. Use defineWorkflowTool() from "eve/tools" and call ctx.agent(target, input) or ctx.ask(request) in its executor.`,
    );
  }
  for (const statement of body) {
    if (typeof statement.directive !== "string") break;
    const directive = readWorkflowDirective(statement);
    if (directive !== undefined) {
      throw new Error(
        `${JSON.stringify(directive)} in "${input.filePath}" is a module-level directive. ` +
          `Put it as the first statement of the function it marks: a top-level "async function" declaration` +
          ` or the ${ENTRY_POINT_METHODS} method of a default-exported defineWorkflowTool().`,
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

  const entryPoints = findDefaultExportEntryPoints(body);
  for (const entryPoint of entryPoints) {
    allowed.add(entryPoint.fn);
  }

  const found = collectDirectiveFunctions(program as AstNode);
  if (found.length === 0) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  const hasWorkflowDirective = found.some((entry) => entry.directive === "use workflow");
  for (const entry of found) {
    if (!allowed.has(entry.fn)) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}. ` +
          `Workflow directives must mark a top-level "async function" declaration` +
          ` or the ${ENTRY_POINT_METHODS} method of a default-exported defineWorkflowTool().`,
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
        `"use step" in "${input.filePath}" marks the default export's "${entryPoint.name}" method. ` +
          `A tool's "${entryPoint.name}" can be a workflow ("use workflow"); steps are the helper functions it calls.`,
      );
    }
  }

  // defineWorkflowTool() accepts one entry point, so only one is hoisted.
  const hoisted = entryPoints.find((entryPoint) =>
    found.some((entry) => entry.fn === entryPoint.fn),
  );
  if (hoisted === undefined) {
    return {
      hasDirectives: true,
      hasWorkflowDirective,
      source: input.source,
    };
  }

  if (declaresTopLevelBinding(body, hoisted.name)) {
    throw new Error(
      `"use workflow" in "${input.filePath}" marks the "${hoisted.name}" method, but the module also declares a top-level "${hoisted.name}" binding. ` +
        `eve hoists that method to a top-level "async function ${hoisted.name}"; rename the existing binding.`,
    );
  }

  return {
    hasDirectives: true,
    hasWorkflowDirective,
    source: hoistEntryPointMethod(input.source, hoisted),
  };
}

function findDefaultExportEntryPoints(body: readonly AstNode[]): EntryPointMethod[] {
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const declaration = exported?.declaration;
  const definition =
    declaration?.type === "CallExpression" ? declaration.arguments?.[0] : declaration;
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
    methods.push({ fn, name, property });
  }
  return methods;
}

function hoistEntryPointMethod(source: string, method: EntryPointMethod): string {
  const { fn, name, property } = method;
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
  const declaration = `async function${star} ${name}${typeParametersText}(${paramsText})${returnTypeText} ${bodyText}`;

  return `${source.slice(0, property.start)}${name}${source.slice(property.end)}\n${declaration}\n`;
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
