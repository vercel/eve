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
  cases?: DynamicToolAstNode[];
  computed?: boolean;
  consequent?: DynamicToolAstNode | DynamicToolAstNode[] | null;
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
  param?: DynamicToolAstNode | null;
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

export function collectPatternNames(pattern: AstNode | null, names: string[]): void {
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

/**
 * Visits each call to one of `definers` that takes a single object literal,
 * with the names bound by its enclosing function, block, catch, loop, and class
 * scopes. Module-scope bindings are excluded.
 */
export function walkDefinerCalls(
  ast: AstNode,
  definers: ReadonlySet<string>,
  visit: (call: AstNode, argument: AstNode, enclosingBindings: ReadonlySet<string>) => void,
): void {
  const walk = (node: AstNode, bindings: ReadonlySet<string>): void => {
    const argument = node.arguments?.[0];
    if (
      node.type === "CallExpression" &&
      definers.has(readDefinerName(node.callee) ?? "") &&
      node.arguments?.length === 1 &&
      argument?.type === "ObjectExpression"
    ) {
      visit(node, argument, bindings);
      return;
    }
    const scoped = node.type === "Program" ? bindings : withScopeBindings(node, bindings);
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) walk(child, scoped);
      }
    }
  };
  walk(ast, new Set());
}

/**
 * Names `node` references at runtime without binding them in a scope that
 * encloses the reference.
 */
export function collectFreeVariables(node: AstNode): Set<string> {
  const free = new Set<string>();

  const visit = (
    current: AstNode,
    context: IdentifierContext,
    bindings: ReadonlySet<string>,
  ): void => {
    if (current.type?.startsWith("TS")) {
      if (isRuntimeTypeScriptExpression(current) && current.expression) {
        visit(current.expression, "reference", bindings);
      }
      return;
    }
    if (
      current.type === "Identifier" &&
      current.name &&
      context === "reference" &&
      !bindings.has(current.name)
    ) {
      free.add(current.name);
    }

    const scoped = withScopeBindings(current, bindings);
    for (const [key, value] of Object.entries(current)) {
      const childContext = getChildContext(current, key, context);
      if (!childContext) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, childContext, scoped);
      }
    }
  };

  visit(node, "reference", new Set());
  return free;
}

function withScopeBindings(node: AstNode, bindings: ReadonlySet<string>): ReadonlySet<string> {
  const names = scopeBindings(node);
  return names.length === 0 ? bindings : new Set([...bindings, ...names]);
}

function scopeBindings(node: AstNode): string[] {
  const names: string[] = [];
  if (isFunction(node)) {
    if (node.type === "FunctionExpression" && node.id?.name) names.push(node.id.name);
    for (const parameter of node.params ?? []) collectPatternNames(parameter, names);
    if (isAstNode(node.body)) collectVarNames(node.body, names);
  } else if (node.type === "BlockStatement" || node.type === "StaticBlock") {
    collectLexicalNames(node.body, names);
  } else if (node.type === "SwitchStatement") {
    for (const switchCase of node.cases ?? []) collectLexicalNames(switchCase.consequent, names);
  } else if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    const declaration = node.type === "ForStatement" ? node.init : node.left;
    if (declaration?.type === "VariableDeclaration" && declaration.kind !== "var") {
      for (const declarator of declaration.declarations ?? []) {
        collectPatternNames(declarator.id as AstNode | null, names);
      }
    }
  } else if (node.type === "CatchClause") {
    collectPatternNames(node.param ?? null, names);
  } else if (node.type === "ClassExpression" && node.id?.name) {
    names.push(node.id.name);
  }
  return names;
}

/** `var` declarations hoist to the nearest function, across nested blocks. */
function collectVarNames(body: AstNode, names: string[]): void {
  walkNode(body, (node) => {
    if (isFunction(node)) return false;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of node.declarations ?? []) {
        collectPatternNames(declarator.id as AstNode | null, names);
      }
    }
    return true;
  });
}

/** Module code is strict, so function and class declarations are block-scoped. */
function collectLexicalNames(
  statements: AstNode["body"] | AstNode["consequent"],
  names: string[],
): void {
  if (!Array.isArray(statements)) return;
  for (const statement of statements) {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      for (const declarator of statement.declarations ?? []) {
        collectPatternNames(declarator.id as AstNode | null, names);
      }
    } else if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration" ||
        statement.type === "TSEnumDeclaration") &&
      statement.id?.name
    ) {
      names.push(statement.id.name);
    }
  }
}
