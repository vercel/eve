import { WORKFLOW_REGISTRY_GLOBAL } from "#execution/workflow-registry.js";
import {
  readWorkflowDirective,
  mayContainWorkflowDirective,
  type WorkflowDirective,
} from "#internal/workflow-bundle/workflow-directive-ast.js";
import { parseWithRolldownAst } from "#internal/bundler/rolldown.js";

import type { WorkflowManifest } from "./workflow-builders.js";

const BUILTIN_STEP_NAMES = new Set([
  "__builtin_response_array_buffer",
  "__builtin_response_json",
  "__builtin_response_text",
  "__builtin_set_attributes",
]);

type WorkflowDirectiveMode = "workflow" | "step" | "client" | "metadata" | false;

type DirectiveFunction = {
  directive: WorkflowDirective;
  directiveEnd: number;
  directiveStart: number;
  exportPrefix: string;
  exported: boolean;
  name: string;
  rangeEnd: number;
  rangeStart: number;
};

type AstProgram = {
  body?: AstNode[];
};

type AstNode = {
  argument?: AstNode | null;
  async?: boolean;
  body?: AstNode[] | { body?: AstNode[] };
  callee?: AstNode | null;
  declaration?: AstNode | null;
  declarations?: AstNode[];
  directive?: string;
  end?: number;
  exported?: { name?: string } | null;
  expression?: AstNode | null;
  expressions?: AstNode[];
  id?: { name?: string } | null;
  importKind?: string;
  init?: AstNode | null;
  kind?: string;
  local?: { name?: string } | null;
  name?: string;
  object?: AstNode | null;
  source?: AstNode | null;
  start?: number;
  specifiers?: AstNode[];
  type?: string;
  value?: unknown;
};

export async function findWorkflowDirectiveFunctions(
  filename: string,
  source: string,
): Promise<readonly { readonly directive: WorkflowDirective; readonly name: string }[]> {
  if (!mayContainWorkflowDirective(source)) return [];
  const ast = await parseWorkflowSource(filename, source);
  return findDirectiveFunctions(ast).map((fn) => ({ directive: fn.directive, name: fn.name }));
}

export async function transformWorkflowDirectives(input: {
  authored?: boolean;
  authorizeSteps?: boolean;
  filename: string;
  mode: WorkflowDirectiveMode;
  moduleSpecifier: string | undefined;
  source: string;
  stableModuleSpecifier?: string | undefined;
  stableWorkflowNames?: ReadonlySet<string>;
}): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
}> {
  if (input.mode === false || !mayContainWorkflowDirective(input.source)) {
    return { code: input.source, workflowManifest: {} };
  }

  const ast = await parseWorkflowSource(input.filename, input.source);
  const functions = findDirectiveFunctions(ast);
  const authorizeSteps = input.authorizeSteps === true;
  const hasAuthorizationSteps =
    authorizeSteps &&
    functions.some((fn) => fn.directive === "use step" && !BUILTIN_STEP_NAMES.has(fn.name));

  if (functions.length === 0) {
    return { code: input.source, workflowManifest: {} };
  }

  const defaultIdBase = input.moduleSpecifier ?? `./${stripJavaScriptExtension(input.filename)}`;
  const stableIdBase = input.stableModuleSpecifier ?? defaultIdBase;
  const manifest: WorkflowManifest = {};
  const replacements: { end: number; start: number; text: string }[] = [];
  const suffixes: string[] = [];
  let hasStepRegistration = false;
  const workflowStepImport = "#execution/tools/workflow/step.js";
  const stepExecutionImport = input.authored
    ? "eve/internal/workflow-step-execution"
    : "#execution/tools/workflow/step-execution.js";

  for (const fn of functions) {
    if (fn.directive === "use step") {
      const stepId = createStepId(defaultIdBase, fn.name);
      manifest.steps ??= {};
      const stepsForFile = (manifest.steps[input.filename] ??= {});
      stepsForFile[fn.name] = { stepId };
      const authorizationStepId = authorizationTwinId(defaultIdBase, fn.name, authorizeSteps);
      if (authorizationStepId !== undefined)
        stepsForFile[`${fn.name}${AUTHORIZATION_STEP_SUFFIX}`] = { stepId: authorizationStepId };

      if (input.mode === "workflow") {
        const exportPrefix = fn.exportPrefix.length > 0 ? "export " : "";
        replacements.push({
          end: fn.rangeEnd,
          start: fn.rangeStart,
          text: `${exportPrefix}var ${fn.name} = ${createStepProxy(defaultIdBase, fn.name, authorizeSteps)};`,
        });
      } else if (input.mode === "metadata") {
        continue;
      } else {
        replacements.push({ end: fn.directiveEnd, start: fn.directiveStart, text: "" });

        if (input.mode === "step") {
          hasStepRegistration = true;
          const plain =
            authorizationStepId === undefined ? fn.name : `withWorkflowStepScope(${fn.name})`;
          suffixes.push(`registerStepFunction(${JSON.stringify(stepId)}, ${plain});`);
          if (authorizationStepId !== undefined) {
            suffixes.push(
              `registerStepFunction(${JSON.stringify(authorizationStepId)}, withWorkflowStepAuthorization(${fn.name}));`,
            );
          }
        } else {
          suffixes.push(`${fn.name}.stepId = ${JSON.stringify(stepId)};`);
        }
      }

      continue;
    }

    const isStable = input.stableWorkflowNames?.has(fn.name) === true;
    const workflowId = createWorkflowId(isStable ? stableIdBase : defaultIdBase, fn.name);
    manifest.workflows ??= {};
    const workflowsForFile = (manifest.workflows[input.filename] ??= {});
    workflowsForFile[fn.name] = { workflowId };

    if (input.mode === "workflow") {
      replacements.push({ end: fn.directiveEnd, start: fn.directiveStart, text: "" });
      suffixes.push(`${fn.name}.workflowId = ${JSON.stringify(workflowId)};`);
      suffixes.push(
        `globalThis.${WORKFLOW_REGISTRY_GLOBAL}.set(${JSON.stringify(workflowId)}, ${fn.name});`,
      );
    } else if (input.mode === "metadata") {
      suffixes.push(`${fn.name}.workflowId = ${JSON.stringify(workflowId)};`);
    } else {
      replacements.push({
        end: fn.directiveEnd,
        start: fn.directiveStart,
        text: `throw new Error(${JSON.stringify(
          `You attempted to execute workflow ${fn.name} function directly. To start a workflow, use start(${fn.name}) from eve/workflow/api`,
        )});`,
      });
      suffixes.push(`${fn.name}.workflowId = ${JSON.stringify(workflowId)};`);
    }
  }
  const manifestComment = `/**__internal_workflows${JSON.stringify(manifest)}*/;`;
  const imports: string[] = [];
  if (hasStepRegistration) {
    imports.push('import { registerStepFunction } from "workflow/internal/private";');
  }
  if (hasAuthorizationSteps && input.mode === "workflow") {
    imports.push(`import { workflowToolStep } from ${JSON.stringify(workflowStepImport)};`);
  } else if (hasAuthorizationSteps && hasStepRegistration) {
    imports.push(
      `import { withWorkflowStepAuthorization, withWorkflowStepScope } from ${JSON.stringify(stepExecutionImport)};`,
    );
  }
  const prefix = [...imports, manifestComment].join("\n");
  const hasWorkflowDirective = functions.some((fn) => fn.directive === "use workflow");
  if (input.mode === "workflow" && !hasWorkflowDirective && input.authored !== true) {
    const proxies = createWorkflowStepProxySource(
      input.source,
      ast,
      functions,
      defaultIdBase,
      authorizeSteps,
    );
    return { code: `${prefix}\n${proxies}`, workflowManifest: manifest };
  }
  if (input.mode === "workflow" && input.authored === true) {
    replacements.push(...removeEveDefinerDefaultExport(ast));
  }
  const replacedSource = applySourceReplacements(input.source, replacements);
  const transformedSource =
    input.mode === "workflow"
      ? await stripUnusedValueImports(input.filename, replacedSource)
      : replacedSource;
  const suffix = suffixes.length > 0 ? `\n${suffixes.join("\n")}\n` : "";
  return { code: `${prefix}\n${transformedSource}${suffix}`, workflowManifest: manifest };
}

async function parseWorkflowSource(filename: string, source: string): Promise<AstProgram> {
  return (await parseWithRolldownAst(filename, source)) as AstProgram;
}

function createWorkflowStepProxySource(
  source: string,
  ast: AstProgram,
  functions: readonly DirectiveFunction[],
  idBase: string,
  authorizeSteps: boolean,
): string {
  const literalExports = findExportedLiteralValueDeclarations(source, ast);
  const proxies = functions
    .filter((fn) => fn.directive === "use step")
    .map((fn) => {
      const exportPrefix = fn.exported ? "export " : "";
      return `${exportPrefix}var ${fn.name} = ${createStepProxy(idBase, fn.name, authorizeSteps)};`;
    });
  const lines = [...literalExports, ...proxies];

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

const AUTHORIZATION_STEP_SUFFIX = ":eve-authorization";

function authorizationTwinId(idBase: string, name: string, enabled: boolean): string | undefined {
  if (!enabled || BUILTIN_STEP_NAMES.has(name)) return undefined;
  return createStepId(idBase, `${name}${AUTHORIZATION_STEP_SUFFIX}`);
}

function createStepProxy(idBase: string, name: string, authorizeSteps: boolean): string {
  const useStep = (id: string) =>
    `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(id)})`;
  const proxy = useStep(createStepId(idBase, name));
  const twinId = authorizationTwinId(idBase, name, authorizeSteps);
  return twinId === undefined ? proxy : `workflowToolStep(${proxy}, ${useStep(twinId)})`;
}

function findDirectiveFunctions(ast: AstProgram): DirectiveFunction[] {
  const functions: DirectiveFunction[] = [];
  const namesReExportedAtModuleLevel = collectLocalNamesReExportedAtModuleLevel(ast);

  for (const node of ast.body ?? []) {
    const topLevelFunction = readTopLevelFunctionDeclaration(node);

    if (topLevelFunction === null) {
      continue;
    }

    const fn = topLevelFunction.fn;
    const name = fn.id?.name;
    const bodyStatements = readBlockStatements(fn.body);

    if (fn.async !== true || name === undefined || bodyStatements === undefined) {
      continue;
    }

    const directive = readFunctionDirective(bodyStatements[0]);

    if (directive === null) {
      continue;
    }

    functions.push({
      directive: directive.value,
      directiveEnd: directive.end,
      directiveStart: directive.start,
      exportPrefix: topLevelFunction.exported ? "export " : "",
      exported: topLevelFunction.exported || namesReExportedAtModuleLevel.has(name),
      name,
      rangeEnd: topLevelFunction.end,
      rangeStart: topLevelFunction.start,
    });
  }

  return functions;
}

function collectLocalNamesReExportedAtModuleLevel(ast: AstProgram): Set<string> {
  const result = new Set<string>();

  for (const node of ast.body ?? []) {
    if (node.type !== "ExportNamedDeclaration") {
      continue;
    }

    if (node.source !== undefined && node.source !== null) {
      continue;
    }

    if (node.declaration !== undefined && node.declaration !== null) {
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      const localName = specifier.local?.name;

      if (localName !== undefined) {
        result.add(localName);
      }
    }
  }

  return result;
}

function readTopLevelFunctionDeclaration(node: AstNode): {
  end: number;
  exported: boolean;
  fn: AstNode;
  start: number;
} | null {
  if (node.type === "FunctionDeclaration") {
    return readFunctionDeclarationRange(node, false, node);
  }

  if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "FunctionDeclaration") {
    return null;
  }

  return readFunctionDeclarationRange(node.declaration, true, node);
}

function readFunctionDeclarationRange(
  fn: AstNode,
  exported: boolean,
  rangeNode: AstNode,
): { end: number; exported: boolean; fn: AstNode; start: number } | null {
  if (
    fn.start === undefined ||
    fn.end === undefined ||
    rangeNode.start === undefined ||
    rangeNode.end === undefined
  ) {
    return null;
  }

  return {
    end: rangeNode.end,
    exported,
    fn,
    start: rangeNode.start,
  };
}

function readBlockStatements(block: AstNode["body"]): AstNode[] | undefined {
  if (block === undefined || Array.isArray(block)) {
    return block;
  }

  return block.body;
}

function readFunctionDirective(
  statement: AstNode | undefined,
): { end: number; start: number; value: WorkflowDirective } | null {
  const value = readWorkflowDirective(statement);
  if (value === undefined || statement?.start === undefined || statement.end === undefined) {
    return null;
  }
  return { end: statement.end, start: statement.start, value };
}

function applySourceReplacements(
  source: string,
  replacements: readonly { end: number; start: number; text: string }[],
): string {
  let result = "";
  let cursor = 0;

  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    result += source.slice(cursor, replacement.start);
    result += replacement.text;
    cursor = replacement.end;
  }

  return result + source.slice(cursor);
}

function removeEveDefinerDefaultExport(
  ast: AstProgram,
): { end: number; start: number; text: string }[] {
  const eveBindings = new Set<string>();

  for (const node of ast.body ?? []) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
    const source = node.source?.value;
    if (typeof source !== "string" || !/^eve(?:\/|$)/.test(source)) continue;
    for (const specifier of node.specifiers ?? []) {
      if (specifier.importKind === "type") continue;
      const name = specifier.local?.name;
      if (name !== undefined) eveBindings.add(name);
    }
  }

  const removals: { end: number; start: number; text: string }[] = [];
  for (const node of ast.body ?? []) {
    if (node.type !== "ExportDefaultDeclaration" || node.start === undefined) continue;
    const call = node.declaration;
    if (call?.type !== "CallExpression" || node.end === undefined) continue;
    const callee = call.callee;
    const binding = callee?.type === "MemberExpression" ? callee.object : callee;
    if (binding?.type !== "Identifier" || !eveBindings.has(binding.name ?? "")) continue;
    removals.push({ end: node.end, start: node.start, text: "" });
  }

  return removals;
}

async function stripUnusedValueImports(filename: string, source: string): Promise<string> {
  const ast = await parseWorkflowSource(filename, source);
  const referencedIdentifiers = collectReferencedIdentifiers(ast);
  const removals: { end: number; start: number; text: string }[] = [];

  for (const node of ast.body ?? []) {
    if (node.type !== "ImportDeclaration" || node.start === undefined || node.end === undefined) {
      continue;
    }

    const bindings = readValueImportBindings(node);

    if (bindings.length > 0 && bindings.every((binding) => !referencedIdentifiers.has(binding))) {
      removals.push({ end: extendRemovalEnd(source, node.end), start: node.start, text: "" });
    }
  }

  return removals.length > 0 ? applySourceReplacements(source, removals) : source;
}

function findExportedLiteralValueDeclarations(source: string, ast: AstProgram): string[] {
  const declarations: string[] = [];
  const reExportAliasesByLocalName = collectLocalReExportAliases(ast);

  for (const node of ast.body ?? []) {
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration" &&
      node.declaration.kind === "const" &&
      node.start !== undefined &&
      node.end !== undefined &&
      (node.declaration.declarations ?? []).every(isLiteralValueDeclarator)
    ) {
      declarations.push(source.slice(node.start, node.end).trim());
      continue;
    }

    if (
      node.type === "VariableDeclaration" &&
      (node.kind === "const" || node.kind === "var" || node.kind === "let")
    ) {
      for (const declarator of node.declarations ?? []) {
        if (!isLiteralValueDeclarator(declarator)) continue;
        if (declarator.start === undefined || declarator.end === undefined) {
          continue;
        }

        const declaratorName = declarator.id?.name;
        if (declaratorName === undefined) continue;

        const aliases = reExportAliasesByLocalName.get(declaratorName);
        if (aliases === undefined || aliases.length === 0) continue;

        const declaratorText = source.slice(declarator.start, declarator.end).trim();
        const aliasClauses = aliases.map((exportedName) =>
          exportedName === declaratorName ? declaratorName : `${declaratorName} as ${exportedName}`,
        );

        declarations.push(
          `${node.kind} ${declaratorText};\nexport { ${aliasClauses.join(", ")} };`,
        );
      }
    }
  }

  return declarations;
}

function collectLocalReExportAliases(ast: AstProgram): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const node of ast.body ?? []) {
    if (node.type !== "ExportNamedDeclaration") continue;
    if (node.source !== undefined && node.source !== null) continue;
    if (node.declaration !== undefined && node.declaration !== null) continue;

    for (const specifier of node.specifiers ?? []) {
      const localName = specifier.local?.name;
      const exportedName = specifier.exported?.name ?? localName;

      if (localName !== undefined && exportedName !== undefined) {
        const list = result.get(localName) ?? [];
        list.push(exportedName);
        result.set(localName, list);
      }
    }
  }

  return result;
}

function isLiteralValueDeclarator(declarator: AstNode): boolean {
  return isLiteralValueExpression(declarator.init);
}

function isLiteralValueExpression(node: AstNode | null | undefined): boolean {
  if (node === null || node === undefined) {
    return false;
  }

  if (node.type === "Literal") {
    return (
      node.value === null ||
      typeof node.value === "boolean" ||
      typeof node.value === "number" ||
      typeof node.value === "string"
    );
  }

  if (node.type === "TemplateLiteral" && (node.expressions ?? []).length === 0) {
    return true;
  }

  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion"
  ) {
    return isLiteralValueExpression(node.expression);
  }

  if (node.type === "UnaryExpression" && node.argument?.type === "Literal") {
    return typeof node.argument.value === "number";
  }

  return false;
}

function readValueImportBindings(node: AstNode): string[] {
  if (node.importKind === "type") {
    return [];
  }

  return (node.specifiers ?? [])
    .filter((specifier) => specifier.importKind !== "type")
    .map((specifier) => specifier.local?.name)
    .filter((name): name is string => name !== undefined);
}

function collectReferencedIdentifiers(ast: AstProgram): Set<string> {
  const identifiers = new Set<string>();

  visitAstNode(ast as AstNode, (node) => {
    if (node.type === "Identifier" && typeof node.name === "string") {
      identifiers.add(node.name);
    }
  });

  return identifiers;
}

function visitAstNode(node: AstNode, visitor: (node: AstNode) => void): void {
  if (node.type === "ImportDeclaration" || node.type?.startsWith("TS")) {
    return;
  }

  visitor(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          visitAstNode(item, visitor);
        }
      }
    } else if (isAstNode(value)) {
      visitAstNode(value, visitor);
    }
  }
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function extendRemovalEnd(source: string, end: number): number {
  let cursor = end;

  while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor += 1;
  }

  if (source[cursor] === "\r" && source[cursor + 1] === "\n") {
    return cursor + 2;
  }

  if (source[cursor] === "\n") {
    return cursor + 1;
  }

  return cursor;
}

export function stripJavaScriptExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

export function createWorkflowId(idBase: string, functionName: string): string {
  return `workflow//${idBase}//${functionName}`;
}

function createStepId(idBase: string, functionName: string): string {
  if (BUILTIN_STEP_NAMES.has(functionName)) {
    return functionName;
  }

  return `step//${idBase}//${functionName}`;
}
