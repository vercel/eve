import { detectWorkflowPatterns } from "#compiled/@workflow/builders/index.js";

import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";
import { readWorkflowDirective } from "#internal/workflow-bundle/workflow-directive-ast.js";

const HOISTED_EXECUTE_NAME = "execute";

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
  callee?: AstNode;
  source?: AstNode;
  imported?: AstNode;
  object?: AstNode;
  property?: AstNode;
};

type AstProgram = { body?: AstNode[] };

interface DirectiveFunctionNode {
  readonly directive: string;
  readonly fn: AstNode;
}

export interface AuthoredWorkflowDirectiveSource {
  /** Name of the top-level `"use workflow"` function the default export's `execute` is or references. */
  readonly executeWorkflow?: string;
  readonly hasDirectives: boolean;
  readonly hasWorkflowDirective: boolean;
  readonly source: string;
}

/**
 * The directive transform understands one shape: a top-level `async function`
 * whose first statement is the directive. A marked `defineWorkflowTool` executor is hoisted
 * into that shape here; every other placement is a build error, because an
 * ignored directive would run side effects inline in a replayed body.
 */
export async function prepareAuthoredWorkflowDirectives(input: {
  readonly filePath: string;
  readonly source: string;
}): Promise<AuthoredWorkflowDirectiveSource> {
  const parsePath = /\.[cm]?js$/.test(input.filePath) ? `${input.filePath}.jsx` : input.filePath;
  const program = (await parseWithNitroRolldownAst(parsePath, input.source)) as AstProgram;
  const body = program.body ?? [];
  if (body.some((node) => node.source?.value === "eve/workflow")) {
    throw new Error(
      `${input.filePath}: "eve/workflow" has been removed. Use defineWorkflowTool() from "eve/tools" and call ctx.agent(input) or ctx.ask(request) in its executor.`,
    );
  }
  const workflowTool = isDefaultWorkflowTool(body);
  if (workflowTool) {
    const property = findDefaultExportExecuteProperty(body);
    const value = property?.value;
    const fn =
      isAstNode(value) && value.type === "Identifier"
        ? body
            .map((node) => node.declaration ?? node)
            .find((node) => node.type === "FunctionDeclaration" && node.id?.name === value.name)
        : isAstNode(value) && isFunctionLike(value)
          ? value
          : undefined;
    if (
      fn === undefined ||
      fn.async !== true ||
      !isAstNode(fn.body) ||
      (fn.body.type !== "BlockStatement" && fn.type !== "ArrowFunctionExpression")
    ) {
      throw new Error(
        `${input.filePath}: defineWorkflowTool() requires an async execute body or a local top-level async function reference.`,
      );
    }
    if (readLeadingDirective(fn) !== "use workflow") {
      throw new Error(
        `${input.filePath}: defineWorkflowTool() execute must start with "use workflow" as the first statement, on its own line.`,
      );
    }
  }

  for (const statement of body) {
    if (typeof statement.directive !== "string") break;
    const directive = readWorkflowDirective(statement);
    if (directive !== undefined) {
      throw new Error(
        `${JSON.stringify(directive)} in "${input.filePath}" is a module-level directive. ` +
          `Put it as the first statement of the function it marks: a top-level "async function" declaration` +
          ` or the "execute" method of a default-exported defineWorkflowTool().`,
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

  const executeProperty = findDefaultExportExecuteProperty(body);
  const executeFunction =
    executeProperty !== undefined &&
    isAstNode(executeProperty.value) &&
    isFunctionLike(executeProperty.value)
      ? executeProperty.value
      : undefined;
  if (executeFunction !== undefined) {
    if (!workflowTool && readLeadingDirective(executeFunction) === "use workflow") {
      throw new Error(
        `${input.filePath}: Workflow executors require defineWorkflowTool() from "eve/tools". Replace defineTool() or the bare tool object with defineWorkflowTool().`,
      );
    }
    allowed.add(executeFunction);
  }

  const found = collectDirectiveFunctions(program as AstNode);
  if (found.length === 0) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  const hasWorkflowDirective = found.some((entry) => entry.directive === "use workflow");
  // Discovery gates on the SDK's line-based pre-scan; a directive it cannot see
  // would compile here into a stub with no run behind it.
  const visibleToPrescan = detectWorkflowPatterns(input.source).hasDirective;

  for (const entry of found) {
    if (!visibleToPrescan) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" is not on its own line. ` +
          `Write it as the first statement of the function body, on a line by itself.`,
      );
    }
    if (!allowed.has(entry.fn)) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}. ` +
          `Workflow directives must mark a top-level "async function" declaration` +
          ` or the "execute" method of a default-exported defineWorkflowTool().`,
      );
    }
    if (entry.fn.async !== true) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}, which is not async. ` +
          `Declare it with "async function".`,
      );
    }
    if (entry.fn === executeFunction && entry.directive !== "use workflow") {
      throw new Error(
        `"use step" in "${input.filePath}" marks the default export's "execute" method. ` +
          `A tool's "execute" can be a workflow ("use workflow"); steps are the helper functions it calls.`,
      );
    }
  }

  const hoist = found.find((entry) => entry.fn === executeFunction);
  if (hoist === undefined || executeProperty === undefined) {
    const prepared: AuthoredWorkflowDirectiveSource = {
      hasDirectives: true,
      hasWorkflowDirective,
      source: input.source,
    };
    const referenced = readExecuteReference(executeProperty, found);
    return referenced === undefined ? prepared : { ...prepared, executeWorkflow: referenced };
  }

  if (declaresTopLevelBinding(body, HOISTED_EXECUTE_NAME)) {
    throw new Error(
      `"use workflow" in "${input.filePath}" marks the "execute" method, but the module also declares a top-level "${HOISTED_EXECUTE_NAME}" binding. ` +
        `eve hoists that method to a top-level "async function ${HOISTED_EXECUTE_NAME}"; rename the existing binding.`,
    );
  }

  return {
    executeWorkflow: HOISTED_EXECUTE_NAME,
    hasDirectives: true,
    hasWorkflowDirective,
    source: hoistExecuteMethod(input.source, executeProperty, hoist.fn),
  };
}

/** `execute: deploy`, where `deploy` is a top-level `"use workflow"` declaration. */
function readExecuteReference(
  executeProperty: AstNode | undefined,
  found: readonly DirectiveFunctionNode[],
): string | undefined {
  const value = executeProperty?.value;
  if (!isAstNode(value) || value.type !== "Identifier" || typeof value.name !== "string") {
    return undefined;
  }
  const name = value.name;
  const target = found.find(
    (entry) => entry.directive === "use workflow" && entry.fn.id?.name === name,
  );
  return target === undefined ? undefined : name;
}

function findDefaultExportExecuteProperty(body: readonly AstNode[]): AstNode | undefined {
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const declaration = exported?.declaration;
  const definition =
    declaration?.type === "CallExpression" ? declaration.arguments?.[0] : declaration;
  if (definition?.type !== "ObjectExpression") return undefined;

  return definition.properties?.find(
    (property) =>
      property.type === "Property" &&
      property.kind === "init" &&
      property.computed !== true &&
      readPropertyName(property.key) === HOISTED_EXECUTE_NAME,
  );
}

function hoistExecuteMethod(source: string, property: AstNode, fn: AstNode): string {
  if (
    property.start === undefined ||
    property.end === undefined ||
    !isAstNode(fn.body) ||
    fn.body.start === undefined ||
    fn.body.end === undefined
  ) {
    throw new Error("Cannot hoist an execute method without source ranges.");
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
  const declaration = `async function${star} ${HOISTED_EXECUTE_NAME}${typeParametersText}(${paramsText})${returnTypeText} ${bodyText}`;

  return `${source.slice(0, property.start)}${HOISTED_EXECUTE_NAME}${source.slice(property.end)}\n${declaration}\n`;
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

function isDefaultWorkflowTool(body: readonly AstNode[]): boolean {
  const call = body.find((node) => node.type === "ExportDefaultDeclaration")?.declaration;
  if (call?.type !== "CallExpression") return false;
  return body.some(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.source?.value === "eve/tools" &&
      node.specifiers?.some((specifier) => {
        if (specifier.type === "ImportSpecifier") {
          return (
            readPropertyName(specifier.imported) === "defineWorkflowTool" &&
            call.callee?.type === "Identifier" &&
            call.callee.name === specifier.local?.name
          );
        }
        return (
          specifier.type === "ImportNamespaceSpecifier" &&
          call.callee?.type === "MemberExpression" &&
          call.callee.object?.name === specifier.local?.name &&
          (call.callee.computed !== true || call.callee.property?.type === "Literal") &&
          readPropertyName(call.callee.property) === "defineWorkflowTool"
        );
      }),
  );
}
