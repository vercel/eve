/** Rolldown AST subset consumed by the dynamic-tool transform. */
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
  end?: number;
  expression?: DynamicToolAstNode | null;
  id?: { name?: string; start?: number; end?: number } | null;
  init?: DynamicToolAstNode | null;
  key?: DynamicToolAstNode | null;
  kind?: string;
  left?: DynamicToolAstNode | null;
  method?: boolean;
  name?: string;
  params?: DynamicToolAstNode[];
  properties?: DynamicToolAstNode[];
  right?: DynamicToolAstNode | null;
  start?: number;
  type?: string;
  value?: DynamicToolAstNode | unknown;
};

/**
 * Collects identifiers used as runtime references in a function body AST.
 */
export function collectReferencedIdentifierNames(node: DynamicToolAstNode): Set<string> {
  const names = new Set<string>();

  const visit = (
    current: DynamicToolAstNode,
    parent: DynamicToolAstNode | undefined,
    parentKey: string | undefined,
    ancestors: readonly DynamicToolAstNode[],
  ): void => {
    if (
      current.type === "Identifier" &&
      current.name &&
      isIdentifierReference(parent, parentKey, ancestors)
    ) {
      names.add(current.name);
    }

    const nextAncestors = [...ancestors, current];
    for (const [key, value] of Object.entries(current)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) {
            visit(child, current, key, nextAncestors);
          }
        }
      } else if (isAstNode(value)) {
        visit(value, current, key, nextAncestors);
      }
    }
  };

  visit(node, undefined, undefined, []);
  return names;
}

function isIdentifierReference(
  parent: DynamicToolAstNode | undefined,
  parentKey: string | undefined,
  ancestors: readonly DynamicToolAstNode[],
): boolean {
  if (!parent || !parentKey) return false;

  if (
    parentKey === "typeAnnotation" ||
    parentKey === "returnType" ||
    parentKey === "typeParameters" ||
    parentKey === "typeArguments" ||
    ancestors.some((ancestor) => ancestor.type?.startsWith("TS"))
  ) {
    return false;
  }

  if (
    (parent.type === "MemberExpression" ||
      parent.type === "OptionalMemberExpression" ||
      parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parentKey === "key"
  ) {
    return parent.computed === true;
  }

  if (
    (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
    parentKey === "property"
  ) {
    return parent.computed === true;
  }

  if (
    (parent.type === "VariableDeclarator" && parentKey === "id") ||
    ((parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionDeclaration") &&
      (parentKey === "id" || parentKey === "params")) ||
    (parent.type === "CatchClause" && parentKey === "param") ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
      parentKey === "id") ||
    ((parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
      parentKey === "label")
  ) {
    return false;
  }

  if (
    parent.type === "ObjectPattern" ||
    parent.type === "ArrayPattern" ||
    ancestors.some(
      (ancestor) => ancestor.type === "ObjectPattern" || ancestor.type === "ArrayPattern",
    )
  ) {
    return false;
  }

  return true;
}

function isAstNode(value: unknown): value is DynamicToolAstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as DynamicToolAstNode).type === "string"
  );
}
