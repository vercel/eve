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
};

type AstProgram = { body?: AstNode[] };

interface DirectiveFunctionNode {
  readonly directive: string;
  readonly fn: AstNode;
}

export interface AuthoredWorkflowDirectiveSource {
  /** `true` when the module marks at least one function with a Workflow directive. */
  readonly hasDirectives: boolean;
  /** `true` when the module declares at least one `"use workflow"` function. */
  readonly hasWorkflowDirective: boolean;
  /** Module source with the default export's `execute` method hoisted to a declaration. */
  readonly source: string;
}

/**
 * Validates and normalizes Workflow directives in one authored application
 * module before the directive transform runs on it.
 *
 * eve's directive transform understands one shape: a top-level `async
 * function` declaration whose first statement is `"use step"` or
 * `"use workflow"`. Authored tools additionally write the workflow body as
 * the `execute` method of their default export, so that method is hoisted
 * here into a top-level `async function execute` and the property rewritten
 * to reference it. Every other directive placement is rejected with the
 * rewrite the author needs, because an ignored directive would run
 * side-effecting code inline in a replayed body.
 */
export async function prepareAuthoredWorkflowDirectives(input: {
  readonly filePath: string;
  readonly source: string;
}): Promise<AuthoredWorkflowDirectiveSource> {
  const program = (await parseWithNitroRolldownAst(input.filePath, input.source)) as AstProgram;
  const body = program.body ?? [];

  for (const statement of body) {
    if (typeof statement.directive !== "string") break;
    if (readWorkflowDirective(statement) !== undefined) {
      throw new Error(
        `Authored module "${input.filePath}" has a module-level ${JSON.stringify(statement.directive)} directive. ` +
          `Put the directive as the first statement of the function it marks: a top-level "async function" declaration` +
          ` or, for "use workflow", the "execute" method of the module's default export.`,
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
    executeProperty !== undefined && isAstNode(executeProperty.value)
      ? executeProperty.value
      : undefined;
  if (executeFunction !== undefined) allowed.add(executeFunction);

  const found = collectDirectiveFunctions(program as AstNode);
  if (found.length === 0) {
    return { hasDirectives: false, hasWorkflowDirective: false, source: input.source };
  }
  // Module discovery gates on the Workflow SDK's line-based pre-scan before it
  // parses anything. A directive that pre-scan cannot see would still be
  // compiled here into a stub with no run behind it, so it is rejected instead.
  if (!detectWorkflowPatterns(input.source).hasDirective) {
    const [entry] = found;
    throw new Error(
      `${JSON.stringify(entry!.directive)} in "${input.filePath}" is not on its own line. ` +
        `Write the directive as the first statement of the function body, on a line by itself.`,
    );
  }
  const hasWorkflowDirective = found.some((entry) => entry.directive === "use workflow");

  for (const entry of found) {
    if (!allowed.has(entry.fn)) {
      throw new Error(
        `${JSON.stringify(entry.directive)} in "${input.filePath}" marks ${describeFunction(entry.fn)}. ` +
          `Workflow directives must mark a top-level "async function" declaration` +
          ` or, for "use workflow", the "execute" method of the module's default export.`,
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
    return { hasDirectives: true, hasWorkflowDirective, source: input.source };
  }

  if (declaresTopLevelBinding(body, HOISTED_EXECUTE_NAME)) {
    throw new Error(
      `"${input.filePath}" declares a top-level "${HOISTED_EXECUTE_NAME}" binding and a "use workflow" "execute" method. ` +
        `eve hoists that method to a top-level "async function ${HOISTED_EXECUTE_NAME}"; rename the existing binding.`,
    );
  }

  return {
    hasDirectives: true,
    hasWorkflowDirective,
    source: hoistExecuteMethod(input.source, executeProperty, hoist.fn),
  };
}

/**
 * Finds the `execute` method of the module's default export: the object
 * literal itself, or the object literal passed to a definer such as
 * `defineTool({ ... })`.
 */
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
      readPropertyName(property.key) === HOISTED_EXECUTE_NAME &&
      isAstNode(property.value) &&
      isFunctionLike(property.value),
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
