import { readWorkflowDirective } from "#internal/workflow-bundle/workflow-directive-ast.js";
import {
  workflowCallbackErrorMessage,
  workflowToolContextErrorMessage,
} from "#shared/workflow-tool-context.js";

type Node = {
  type?: string;
  name?: string;
  value?: unknown;
  start?: number;
  body?: Node | Node[];
  source?: Node;
  specifiers?: Node[];
  imported?: Node;
  local?: Node;
  declaration?: Node;
  declarations?: Node[];
  id?: Node;
  init?: Node;
  callee?: Node;
  arguments?: Node[];
  object?: Node;
  property?: Node;
  computed?: boolean;
  kind?: string;
  properties?: Node[];
  elements?: Node[];
  key?: Node;
  params?: Node[];
  param?: Node;
};

type CallbackKind = "tool" | "channel" | "schedule" | "step";

/** Only reject known callback contexts; an ordinary helper may inherit a workflow tool's ctx. */
export function validateWorkflowHelperContexts(
  input: { readonly filePath: string; readonly source: string },
  program: unknown,
): void {
  if (!input.source.includes("eve/workflow") && !input.source.includes("use workflow")) return;
  const root = program as Node;
  const ancestors = new WeakMap<Node, readonly Node[]>();
  const bindings = new WeakMap<Node, Set<string>>();
  walk(root, (node, parents) => ancestors.set(node, parents));
  const imports = new Map<string, { source: string; name?: string }>();
  const functions = new Map<string, Node>();
  for (const statement of Array.isArray(root.body) ? root.body : []) {
    if (statement.type === "ImportDeclaration" && typeof statement.source?.value === "string") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name) {
          imports.set(specifier.local.name, {
            source: statement.source.value,
            name:
              specifier.type === "ImportNamespaceSpecifier" ? undefined : name(specifier.imported),
          });
        }
      }
    }
    const declaration = statement.declaration ?? statement;
    if (isFunction(declaration) && declaration.id?.name) {
      functions.set(declaration.id.name, declaration);
    }
    for (const binding of declaration.kind === "const" ? (declaration.declarations ?? []) : []) {
      if (binding.id?.name && binding.init && isFunction(binding.init)) {
        functions.set(binding.id.name, binding.init);
      }
    }
  }

  function imported(node: Node | undefined, source: string): string | undefined {
    const local = node?.object?.name ?? node?.name;
    if (node && local && isShadowed(node, local)) return undefined;
    if (node?.type === "Identifier") {
      const binding = imports.get(node.name ?? "");
      return binding?.source === source ? binding.name : undefined;
    }
    if (node?.type === "MemberExpression" && node.object?.type === "Identifier") {
      const binding = imports.get(node.object.name ?? "");
      if (binding?.source === source && binding.name === undefined) {
        return node.computed ? stringValue(node.property) : name(node.property);
      }
    }
    return undefined;
  }

  function isShadowed(reference: Node, local: string): boolean {
    return (ancestors.get(reference) ?? []).some((scope) => {
      if (
        !isFunction(scope) &&
        ![
          "BlockStatement",
          "CatchClause",
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
          "SwitchStatement",
        ].includes(scope.type ?? "")
      )
        return false;
      let names = bindings.get(scope);
      if (!names) {
        names = new Set<string>();
        const collected = names;
        // Be conservative when nested scopes reuse a name: leave ambiguous calls to the runtime guard.
        walk(scope, (node) => {
          for (const binding of [
            ...(node.params ?? []),
            ...(node.id ? [node.id] : []),
            ...(node.param ? [node.param] : []),
          ]) {
            walk(binding, (part) => {
              if (part.type === "Identifier" && part.name) collected.add(part.name);
            });
          }
        });
        bindings.set(scope, names);
      }
      return names.has(local);
    });
  }

  function fail(node: Node, message: string): never {
    const lines = input.source.slice(0, node.start ?? 0).split("\n");
    throw new Error(
      `${input.filePath}:${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}: ${message}`,
    );
  }

  function checkCallback(fn: Node, kind: CallbackKind, workflowAllowed: boolean): void {
    const directive = leadingDirective(fn);
    if (workflowAllowed && directive === "use workflow") return;
    walk(fn, (node) => {
      if (node.type !== "CallExpression") return;
      const helper = imported(node.callee, "eve/workflow");
      if (helper === "agent" || helper === "ask") {
        fail(node, workflowToolContextErrorMessage(helper));
      }
    });
    if (directive === "use workflow") {
      fail(fn, workflowCallbackErrorMessage(kind));
    }
  }

  function callbacks(node: Node, kind: CallbackKind, workflowAllowed = false): void {
    if (node.type === "Identifier" && isShadowed(node, node.name ?? "")) return;
    const fn = node.type === "Identifier" ? functions.get(node.name ?? "") : node;
    if (fn && isFunction(fn)) {
      checkCallback(fn, kind, workflowAllowed);
      return;
    }
    if (node.type === "Property" && isNode(node.value)) {
      callbacks(node.value, kind);
    }
    if (node.type === "CallExpression") {
      const route = imported(node.callee, "eve/channels");
      if (
        route &&
        ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "WS"].includes(route)
      ) {
        const handler = node.arguments?.[1];
        if (handler) callbacks(handler, kind);
      }
      return;
    }
    for (const child of node.properties ?? node.elements ?? []) {
      if (child) callbacks(child, kind);
    }
  }

  function toolCallbacks(definition: Node): void {
    for (const property of definition.properties ?? []) {
      if (isNode(property.value)) {
        callbacks(property.value, "tool", name(property.key) === "execute");
      }
    }
  }

  walk(root, (node) => {
    if (isFunction(node) && leadingDirective(node) === "use step") {
      checkCallback(node, "step", false);
    }
    if (node.type === "ExportDefaultDeclaration" && node.declaration?.type === "ObjectExpression") {
      const fields = new Set(node.declaration.properties?.map((property) => name(property.key)));
      if (fields.has("description") && fields.has("inputSchema") && fields.has("execute")) {
        toolCallbacks(node.declaration);
      }
    }
    if (node.type !== "CallExpression") return;
    const definition = node.arguments?.[0];
    if (definition?.type !== "ObjectExpression") return;
    if (imported(node.callee, "eve/tools") === "defineTool") {
      toolCallbacks(definition);
    } else if (imported(node.callee, "eve/channels") === "defineChannel") {
      callbacks(definition, "channel");
    } else if (imported(node.callee, "eve/schedules") === "defineSchedule") {
      callbacks(definition, "schedule");
    }
  });
}

function leadingDirective(fn: Node): string | undefined {
  const body = fn.body;
  return readWorkflowDirective(isNode(body) && Array.isArray(body.body) ? body.body[0] : undefined);
}

function name(node: Node | undefined): string | undefined {
  return node?.name ?? stringValue(node);
}

function stringValue(node: Node | undefined): string | undefined {
  return typeof node?.value === "string" ? node.value : undefined;
}

function isFunction(node: Node): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    node.type ?? "",
  );
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) =>
    key === "typeAnnotation" || key === "returnType" || key === "typeParameters"
      ? []
      : (Array.isArray(value) ? value : [value]).filter(isNode),
  );
}

function walk(
  node: Node,
  visit: (node: Node, ancestors: readonly Node[]) => void,
  ancestors: readonly Node[] = [],
): void {
  visit(node, ancestors);
  for (const child of children(node)) walk(child, visit, [...ancestors, node]);
}
