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

type IdentifierContext = "binding" | "reference";

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

function isAstNode(value: unknown): value is DynamicToolAstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as DynamicToolAstNode).type === "string"
  );
}
