/** Rolldown AST subset consumed by the dynamic tool and remote agent transforms. */
export type DynamicToolAstNode = {
  argument?: DynamicToolAstNode | null;
  arguments?: DynamicToolAstNode[];
  async?: boolean;
  body?:
    | DynamicToolAstNode
    | DynamicToolAstNode[]
    | { body?: DynamicToolAstNode[]; type?: string; start?: number; end?: number };
  callee?: DynamicToolAstNode;
  computed?: boolean;
  declaration?: DynamicToolAstNode | null;
  declarations?: DynamicToolAstNode[];
  directive?: string;
  end?: number;
  expression?: DynamicToolAstNode | null;
  generator?: boolean;
  id?: { name?: string; start?: number; end?: number } | null;
  init?: DynamicToolAstNode | null;
  imported?: { name?: string; value?: unknown } | null;
  key?: DynamicToolAstNode | null;
  kind?: string;
  left?: DynamicToolAstNode | null;
  local?: { name?: string } | null;
  method?: boolean;
  name?: string;
  object?: DynamicToolAstNode | null;
  params?: DynamicToolAstNode[];
  properties?: DynamicToolAstNode[];
  property?: DynamicToolAstNode | null;
  right?: DynamicToolAstNode | null;
  source?: { value?: unknown } | null;
  specifiers?: DynamicToolAstNode[];
  start?: number;
  type?: string;
  value?: DynamicToolAstNode | unknown;
  elements?: Array<DynamicToolAstNode | null>;
};

type AstNode = DynamicToolAstNode;

type IdentifierContext = "binding" | "reference";

export function findProperty(
  object: DynamicToolAstNode,
  name: string,
): DynamicToolAstNode | undefined {
  return object.properties?.find(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      (property.key?.type === "Identifier"
        ? property.key.name === name
        : property.key?.value === name),
  );
}

export function walkNode(
  node: DynamicToolAstNode,
  visitor: (node: DynamicToolAstNode) => boolean,
): void {
  if (!visitor(node)) return;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) walkNode(child, visitor);
      }
    } else if (isAstNode(value)) {
      walkNode(value, visitor);
    }
  }
}

/**
 * Collects identifiers used as runtime references in a function body AST.
 */
export function collectReferencedIdentifierNames(node: DynamicToolAstNode): Set<string> {
  const names = new Set<string>();

  const visit = (current: DynamicToolAstNode, context: IdentifierContext): void => {
    if (current.type?.startsWith("TS")) {
      if (isRuntimeTypeScriptExpression(current) && current.expression) {
        visit(current.expression, "reference");
      }
      return;
    }

    if (current.type === "Identifier" && current.name && context === "reference") {
      names.add(current.name);
    }

    for (const [key, value] of Object.entries(current)) {
      const childContext = getChildContext(current, key, context);
      if (!childContext) continue;

      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) {
            visit(child, childContext);
          }
        }
      } else if (isAstNode(value)) {
        visit(value, childContext);
      }
    }
  };

  visit(node, "reference");
  return names;
}

function getChildContext(
  parent: DynamicToolAstNode,
  parentKey: string,
  context: IdentifierContext,
): IdentifierContext | null {
  if (
    parentKey === "typeAnnotation" ||
    parentKey === "returnType" ||
    parentKey === "typeParameters" ||
    parentKey === "typeArguments"
  ) {
    return null;
  }

  if (parent.type === "VariableDeclarator" && parentKey === "id") {
    return "binding";
  }

  if (
    (parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionDeclaration") &&
    (parentKey === "id" || parentKey === "params")
  ) {
    return "binding";
  }

  if (
    (parent.type === "CatchClause" && parentKey === "param") ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
      parentKey === "id")
  ) {
    return "binding";
  }

  if (parent.type === "Property" && parentKey === "key") {
    return parent.computed === true ? "reference" : null;
  }

  if (parent.type === "Property" && parentKey === "value") {
    return context;
  }

  if (parent.type === "AssignmentPattern") {
    return parentKey === "right" ? "reference" : context;
  }

  if (
    (parent.type === "ObjectPattern" ||
      parent.type === "ArrayPattern" ||
      parent.type === "RestElement") &&
    (parentKey === "properties" || parentKey === "elements" || parentKey === "argument")
  ) {
    return context;
  }

  if (
    (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
    parentKey === "property"
  ) {
    return parent.computed === true ? "reference" : null;
  }

  if (
    (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
    parentKey === "key"
  ) {
    return parent.computed === true ? "reference" : null;
  }

  if (
    (parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
    parentKey === "label"
  ) {
    return null;
  }

  return "reference";
}

function isRuntimeTypeScriptExpression(node: DynamicToolAstNode): boolean {
  return (
    node.type === "TSAsExpression" ||
    node.type === "TSInstantiationExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion"
  );
}

export function isAstNode(value: unknown): value is DynamicToolAstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as DynamicToolAstNode).type === "string"
  );
}

/**
 * Local names (`alias` or `namespace.name`) that refer to the given exports of
 * an `eve` or `eve/*` import.
 */
export function findEveImportAliases(ast: AstNode, names: readonly string[]): ReadonlySet<string> {
  const aliases = new Set<string>();
  walkNode(ast, (node) => {
    if (node.type !== "ImportDeclaration") return true;
    const source = node.source?.value;
    if (typeof source !== "string" || (source !== "eve" && !source.startsWith("eve/"))) {
      return false;
    }
    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === "ImportNamespaceSpecifier" && specifier.local?.name) {
        for (const name of names) aliases.add(`${specifier.local.name}.${name}`);
      }
      if (
        specifier.type === "ImportSpecifier" &&
        names.includes(String(specifier.imported?.name ?? specifier.imported?.value)) &&
        specifier.local?.name
      ) {
        aliases.add(specifier.local.name);
      }
    }
    return false;
  });
  return aliases;
}

export function readDefinerName(callee: AstNode | undefined): string | undefined {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type !== "MemberExpression" || callee.object?.type !== "Identifier") return undefined;
  const property = callee.computed ? callee.property?.value : callee.property?.name;
  return typeof property === "string" ? `${callee.object.name}.${property}` : undefined;
}

export function collectScopeVarDeclarations(bodyNode: AstNode): string[] {
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

export function extractParamNames(fn: AstNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params ?? []) collectPatternNames(parameter, names);
  return names;
}

export function isFunction(node: AstNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}
