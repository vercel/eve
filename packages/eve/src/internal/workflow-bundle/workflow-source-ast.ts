import { inferRolldownParserLanguage, parseWithRolldownAst } from "#internal/bundler/rolldown.js";

const MAX_CACHED_SOURCE_LENGTH = 1024 * 1024;

const cache = new Map<string, unknown>();
let cachedSourceLength = 0;

export async function parseWorkflowSourceAst(filename: string, source: string): Promise<unknown> {
  const key = `${inferRolldownParserLanguage(filename)}\0${source}`;
  if (cache.has(key)) {
    const ast = cache.get(key);
    cache.delete(key);
    cache.set(key, ast);
    return ast;
  }
  const ast = await parseWithRolldownAst(filename, source);
  if (key.length > MAX_CACHED_SOURCE_LENGTH || cache.has(key)) return ast;
  cache.set(key, ast);
  cachedSourceLength += key.length;
  for (const cachedKey of cache.keys()) {
    if (cachedSourceLength <= MAX_CACHED_SOURCE_LENGTH) break;
    cache.delete(cachedKey);
    cachedSourceLength -= cachedKey.length;
  }
  return ast;
}

type WalkableAstNode = {
  readonly computed?: boolean;
  readonly exportKind?: string;
  readonly local?: unknown;
  readonly name?: unknown;
  readonly source?: unknown;
  readonly type: string;
  readonly [key: string]: unknown;
};

function isWalkableAstNode(value: unknown): value is WalkableAstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly type?: unknown }).type === "string"
  );
}

const VALUE_BEARING_TS_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function collectBindingPatternReferences(node: unknown, identifiers: Set<string>): void {
  if (!isWalkableAstNode(node)) return;
  if (node.type === "Identifier") return;
  if (node.type === "AssignmentPattern") {
    collectBindingPatternReferences(node.left, identifiers);
    collectAstReferencedIdentifiers(node.right, identifiers);
    return;
  }
  if (node.type === "RestElement") {
    collectBindingPatternReferences(node.argument, identifiers);
    return;
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) collectBindingPatternReferences(element, identifiers);
    return;
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (!isWalkableAstNode(property)) continue;
      if (property.type === "RestElement") {
        collectBindingPatternReferences(property.argument, identifiers);
        continue;
      }
      if (property.computed === true) collectAstReferencedIdentifiers(property.key, identifiers);
      collectBindingPatternReferences(property.value, identifiers);
    }
  }
}

export function collectAstReferencedIdentifiers(
  node: unknown,
  identifiers: Set<string> = new Set(),
): Set<string> {
  if (!isWalkableAstNode(node)) return identifiers;
  if (node.type === "ImportDeclaration") return identifiers;
  if (node.type.startsWith("TS")) {
    if (VALUE_BEARING_TS_EXPRESSIONS.has(node.type)) {
      collectAstReferencedIdentifiers(node.expression, identifiers);
    }
    return identifiers;
  }
  if (node.type === "Identifier") {
    if (typeof node.name === "string") identifiers.add(node.name);
    return identifiers;
  }
  if (node.type === "ExportNamedDeclaration" && node.source != null) return identifiers;
  if (node.type === "ExportSpecifier") {
    if (node.exportKind !== "type") collectAstReferencedIdentifiers(node.local, identifiers);
    return identifiers;
  }
  if (node.type === "VariableDeclarator") {
    collectBindingPatternReferences(node.id, identifiers);
    collectAstReferencedIdentifiers(node.init, identifiers);
    return identifiers;
  }
  const skipPropertyKey =
    (node.type === "Property" ||
      node.type === "MethodDefinition" ||
      node.type === "PropertyDefinition") &&
    node.computed !== true;
  const skipMemberProperty = node.type === "MemberExpression" && node.computed !== true;
  const skipDeclarationId =
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression";
  const skipLabel =
    node.type === "LabeledStatement" ||
    node.type === "BreakStatement" ||
    node.type === "ContinueStatement";

  for (const [key, value] of Object.entries(node)) {
    if (
      (skipPropertyKey && key === "key") ||
      (skipMemberProperty && key === "property") ||
      (skipDeclarationId && key === "id") ||
      (skipLabel && key === "label")
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectAstReferencedIdentifiers(item, identifiers);
    } else if (isWalkableAstNode(value)) {
      collectAstReferencedIdentifiers(value, identifiers);
    }
  }
  return identifiers;
}
