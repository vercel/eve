import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

import type { WorkflowManifest } from "./workflow-builders.js";

// Step names whose `stepId` must be emitted as the bare function name,
// not `step//<idBase>//<name>`. The workflow-body shim's
// `experimental_setAttributes` (and Workflow's compiled equivalent)
// dispatches builtins via `useStep("<name>")` with the unqualified
// identifier — if the registry stored these under their version-stamped
// `step//...//name` ids, the lookup would miss and the runtime would
// raise `Step "__builtin_*" is not registered in the current deployment`.
const BUILTIN_STEP_NAMES = new Set([
  "__builtin_response_array_buffer",
  "__builtin_response_json",
  "__builtin_response_text",
  "__builtin_set_attributes",
]);

type WorkflowDirectiveMode = "workflow" | "step" | "client" | false;

type DirectiveFunction = {
  directive: "use workflow" | "use step";
  directiveEnd: number;
  directiveStart: number;
  /**
   * `"export "` when the function was declared with `export async
   * function foo()`. Empty otherwise — including when the function is
   * re-exported via a trailing `export { foo }` aggregate. The inline
   * replacement path preserves that aggregate, so the rewritten `var`
   * binding becomes visible through it; emitting a second `export `
   * keyword would produce a duplicate-export error.
   */
  exportPrefix: string;
  /**
   * `true` when the function's binding is reachable from any consumer
   * — either declared with `export ` or referenced from a trailing
   * `export { name }` aggregate. The step-only proxy path drops the
   * original source (and the aggregate with it), so the synthesized
   * stub must carry its own `export ` keyword whenever this is set.
   */
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
  source?: AstNode | null;
  start?: number;
  specifiers?: AstNode[];
  type?: string;
  value?: unknown;
};

export async function transformWorkflowDirectives(input: {
  filename: string;
  mode: WorkflowDirectiveMode;
  moduleSpecifier: string | undefined;
  source: string;
  /**
   * Package-qualified module specifier without the `@<pkg.version>`
   * stamp. Used to mint workflow ids for functions named in
   * {@link transformWorkflowDirectives.input.stableWorkflowNames} so
   * the bundled id matches the runtime reference on every deployment.
   */
  stableModuleSpecifier?: string | undefined;
  /**
   * Workflow function names whose bundled id should be emitted without
   * the package version stamp. See `STABLE_WORKFLOW_NAMES` in
   * `workflow-runtime.ts` for the canonical set eve itself uses.
   */
  stableWorkflowNames?: ReadonlySet<string>;
}): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
}> {
  if (input.mode === false) {
    return { code: input.source, workflowManifest: {} };
  }

  const ast = await parseWorkflowSource(input.filename, input.source);
  const functions = findDirectiveFunctions(ast);

  if (functions.length === 0) {
    return { code: input.source, workflowManifest: {} };
  }

  // Step ids stay version-stamped — they are per-deployment internal
  // identifiers, not cross-deployment routing keys. Only workflow
  // functions whose name appears in `stableWorkflowNames` opt out of
  // the version stamp.
  const defaultIdBase = input.moduleSpecifier ?? `./${stripJavaScriptExtension(input.filename)}`;
  const stableIdBase = input.stableModuleSpecifier ?? defaultIdBase;
  const manifest: WorkflowManifest = {};
  const replacements: { end: number; start: number; text: string }[] = [];
  const suffixes: string[] = [];
  let hasStepRegistration = false;

  for (const fn of functions) {
    if (fn.directive === "use step") {
      const stepId = createStepId(defaultIdBase, fn.name);
      manifest.steps ??= {};
      const stepsForFile = (manifest.steps[input.filename] ??= {});
      stepsForFile[fn.name] = { stepId };

      if (input.mode === "workflow") {
        const exportPrefix = fn.exportPrefix.length > 0 ? "export " : "";
        replacements.push({
          end: fn.rangeEnd,
          start: fn.rangeStart,
          text: `${exportPrefix}var ${fn.name} = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(stepId)});`,
        });
      } else {
        replacements.push({ end: fn.directiveEnd, start: fn.directiveStart, text: "" });

        if (input.mode === "step") {
          hasStepRegistration = true;
          suffixes.push(`registerStepFunction(${JSON.stringify(stepId)}, ${fn.name});`);
        } else {
          suffixes.push(`${fn.name}.stepId = ${JSON.stringify(stepId)};`);
        }
      }

      continue;
    }

    const isStable = input.stableWorkflowNames?.has(fn.name) === true;
    const workflowId = `workflow//${isStable ? stableIdBase : defaultIdBase}//${fn.name}`;
    manifest.workflows ??= {};
    const workflowsForFile = (manifest.workflows[input.filename] ??= {});
    workflowsForFile[fn.name] = { workflowId };

    if (input.mode === "workflow") {
      replacements.push({ end: fn.directiveEnd, start: fn.directiveStart, text: "" });
      suffixes.push(`${fn.name}.workflowId = ${JSON.stringify(workflowId)};`);
      suffixes.push(
        `globalThis.__private_workflows.set(${JSON.stringify(workflowId)}, ${fn.name});`,
      );
    } else {
      replacements.push({
        end: fn.directiveEnd,
        start: fn.directiveStart,
        text: `throw new Error(${JSON.stringify(
          `You attempted to execute workflow ${fn.name} function directly. To start a workflow, use start(${fn.name}) from workflow/api`,
        )});`,
      });
      suffixes.push(`${fn.name}.workflowId = ${JSON.stringify(workflowId)};`);
    }
  }

  const manifestComment = `/**__internal_workflows${JSON.stringify(manifest)}*/;`;
  const hasWorkflowDirective = functions.some((fn) => fn.directive === "use workflow");

  if (input.mode === "workflow" && !hasWorkflowDirective) {
    return {
      code: `${manifestComment}\n${createWorkflowStepProxySource(input.source, ast, functions, defaultIdBase)}`,
      workflowManifest: manifest,
    };
  }

  const replacedSource = applySourceReplacements(input.source, replacements);
  const transformedSource =
    input.mode === "workflow"
      ? await stripUnusedValueImports(input.filename, replacedSource)
      : replacedSource;
  const prefix = hasStepRegistration
    ? `import { registerStepFunction } from "workflow/internal/private";\n${manifestComment}\n`
    : `${manifestComment}\n`;
  const suffix = suffixes.length > 0 ? `\n${suffixes.join("\n")}\n` : "";

  return {
    code: `${prefix}${transformedSource}${suffix}`,
    workflowManifest: manifest,
  };
}

async function parseWorkflowSource(filename: string, source: string): Promise<AstProgram> {
  return (await parseWithNitroRolldownAst(filename, source)) as AstProgram;
}

function createWorkflowStepProxySource(
  source: string,
  ast: AstProgram,
  functions: readonly DirectiveFunction[],
  idBase: string,
): string {
  const literalExports = findExportedLiteralValueDeclarations(source, ast);
  const proxies = functions
    .filter((fn) => fn.directive === "use step")
    .map((fn) => {
      // The original source (and any trailing `export { name }`
      // aggregate) is discarded by this path, so the proxy itself must
      // carry the `export ` keyword whenever the function was reachable
      // to importers.
      const exportPrefix = fn.exported ? "export " : "";
      const stepId = createStepId(idBase, fn.name);
      return `${exportPrefix}var ${fn.name} = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(stepId)});`;
    });
  const lines = [...literalExports, ...proxies];

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function findDirectiveFunctions(ast: AstProgram): DirectiveFunction[] {
  const functions: DirectiveFunction[] = [];
  // Rolldown collapses `export async function foo() {}` into a trailing
  // `export { foo, ... }` aggregate when emitting ESM (especially under
  // minify). The inline-replacement path keeps that aggregate intact,
  // but the step-only proxy path discards the original source — so we
  // need both signals: which declarations had inline `export ` keywords
  // (for in-place rewrites that must not double-export) and which names
  // are reachable to consumers (for proxy emission that must carry its
  // own `export `).
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

    // `export { foo } from "./bar.js"` re-exports a binding from another
    // module — `foo` is not a local declaration in this file.
    if (node.source !== undefined && node.source !== null) {
      continue;
    }

    // `export function foo() {}` is already handled by
    // `readTopLevelFunctionDeclaration`.
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
): { end: number; start: number; value: "use workflow" | "use step" } | null {
  const value =
    statement?.directive ??
    (statement?.type === "ExpressionStatement" && statement.expression?.type === "Literal"
      ? statement.expression.value
      : undefined);

  if (
    (value !== "use workflow" && value !== "use step") ||
    statement?.start === undefined ||
    statement.end === undefined
  ) {
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
    // `export const FOO = "literal"` — inline-exported literal const.
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

    // `const FOO = "literal"; export { FOO as PUBLIC_NAME };` —
    // rolldown's preserve-modules ESM emit splits the declaration from
    // the export and frequently renames the local binding under
    // minification. The trailing aggregate is dropped along with the
    // rest of the source, so we re-emit just the declaration plus a
    // targeted `export { local as public }` clause for each alias. All
    // three declaration kinds are accepted defensively in case
    // rolldown's `topLevelVar` option is ever re-enabled. Combined
    // `var a = …, b = "literal"` declarations are also handled — only
    // the literal-valued declarator is re-emitted, since the
    // non-literal initializers may reference imports the step-only
    // proxy path has discarded.
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

  // Rolldown's minifier rewrites string literals into untagged template
  // literals with no interpolations (e.g. `` `subagent` ``). Treat those
  // as literal-valued so the step-only proxy path still preserves them.
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

function stripJavaScriptExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function createStepId(idBase: string, functionName: string): string {
  if (BUILTIN_STEP_NAMES.has(functionName)) {
    return functionName;
  }

  return `step//${idBase}//${functionName}`;
}
