import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral } from "../../shared/literals.ts";
import {
  findAppDirectory,
  getAppRoute,
  isWithin,
  normalizePath,
} from "../helpers/next-app-router.ts";

const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

type ProgramStatement = ESTree.Directive | ESTree.Statement;

type WrappedExpression =
  | ESTree.TSAsExpression
  | ESTree.TSInstantiationExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSSatisfiesExpression;

const isWrappedExpression = (node: ESTree.Node): node is WrappedExpression =>
  node.type === "TSAsExpression" ||
  node.type === "TSInstantiationExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSSatisfiesExpression";

const unwrapExpression = (
  node: ESTree.Node | null | undefined
): ESTree.Node | null | undefined => {
  let expression = node;

  while (expression && isWrappedExpression(expression)) {
    expression = expression.expression;
  }

  return expression;
};

const getFunction = (
  node: ESTree.Node | null | undefined
): FunctionNode | undefined => {
  const expression = unwrapExpression(node);
  switch (expression?.type) {
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
      return expression;
  }
  return undefined;
};

const getIdentifierName = (node: ESTree.Node | null | undefined) =>
  node?.type === "Identifier" ? node.name : undefined;

const getRouteLiteral = (node: ESTree.TSType | undefined) => {
  if (node?.type !== "TSLiteralType") return undefined;
  return isStringLiteral(node.literal) ? node.literal.value : undefined;
};

const hasGeneratedType = (
  parameter: ESTree.ParamPattern,
  helper: string,
  route: string,
  localBindings: Set<string>
) => {
  if (localBindings.has(helper)) return false;

  if (!("typeAnnotation" in parameter)) return false;
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  if (annotation?.type !== "TSTypeReference") return false;
  if (getIdentifierName(annotation.typeName) !== helper) return false;

  const typeArguments = annotation.typeArguments?.params ?? [];
  return (
    typeArguments.length === 1 && getRouteLiteral(typeArguments[0]) === route
  );
};

const getLocalBindings = (body: ProgramStatement[]) => {
  const bindings = new Set<string>();

  for (const statement of body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        bindings.add(specifier.local.name);
      }
      continue;
    }

    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;

    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        const name = getIdentifierName(declarator.id);
        if (name) bindings.add(name);
      }
      continue;
    }

    const name =
      declaration && "id" in declaration
        ? getIdentifierName(declaration.id)
        : undefined;
    if (name) bindings.add(name);
  }

  return bindings;
};

const getDeclaredFunctions = (body: ProgramStatement[]) => {
  const functions = new Map<string, FunctionNode>();

  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;

    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      functions.set(declaration.id.name, declaration);
      continue;
    }

    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") continue;

      const fn = getFunction(declarator.init);
      if (fn) functions.set(declarator.id.name, fn);
    }
  }

  return functions;
};

const resolveFunction = (
  node: ESTree.Node,
  functions: Map<string, FunctionNode>
) => {
  const fn = getFunction(node);
  if (fn) return fn;

  const name = getIdentifierName(unwrapExpression(node));
  return name ? functions.get(name) : undefined;
};

export const requireGeneratedRoutePropsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Use Next.js generated route-aware types for App Router entry points.",
    },
    messages: {
      generatedType:
        'Use the generated {{helper}}<"{{route}}"> type for this {{entry}} so Next.js owns the route contract.',
    },
    schema: [],
  },
  createOnce(context) {
    let kind = "";
    let route = "";
    let reportedParameters = new Set<ESTree.ParamPattern>();

    const reportParameter = (
      parameter: ESTree.ParamPattern | undefined,
      helper: string,
      entry: string,
      localBindings: Set<string>
    ) => {
      if (
        !parameter ||
        reportedParameters.has(parameter) ||
        hasGeneratedType(parameter, helper, route, localBindings)
      ) {
        return;
      }

      reportedParameters.add(parameter);
      context.report({
        node: parameter,
        messageId: "generatedType",
        data: { entry, helper, route },
      });
    };

    return {
      before() {
        const filename = normalizePath(context.filename);
        const match = /^(layout|page|route)\.tsx?$/.exec(
          path.basename(filename)
        );
        if (!match) return false;

        const appDirectory = findAppDirectory(filename);
        if (!appDirectory || !isWithin(filename, appDirectory)) return false;

        kind = match[1] ?? "";
        route = getAppRoute(filename, appDirectory);
        reportedParameters = new Set();
        return undefined;
      },
      Program(program) {
        const functions = getDeclaredFunctions(program.body);
        const localBindings = getLocalBindings(program.body);

        if (kind === "page" || kind === "layout") {
          const defaultExport = program.body.find(
            (statement) => statement.type === "ExportDefaultDeclaration"
          );
          if (!defaultExport) return;

          const fn = resolveFunction(defaultExport.declaration, functions);
          if (!fn) return;

          reportParameter(
            fn.params[0],
            kind === "page" ? "PageProps" : "LayoutProps",
            `${kind} props`,
            localBindings
          );
          return;
        }

        for (const statement of program.body) {
          if (statement.type !== "ExportNamedDeclaration") continue;

          if (statement.declaration?.type === "FunctionDeclaration") {
            const name = getIdentifierName(statement.declaration.id);
            if (name && HTTP_METHODS.has(name)) {
              reportParameter(
                statement.declaration.params[1],
                "RouteContext",
                `${name} context`,
                localBindings
              );
            }
          }

          if (statement.declaration?.type === "VariableDeclaration") {
            for (const declarator of statement.declaration.declarations) {
              const name = getIdentifierName(declarator.id);
              if (!name || !HTTP_METHODS.has(name)) continue;

              const fn = getFunction(declarator.init);
              if (fn) {
                reportParameter(
                  fn.params[1],
                  "RouteContext",
                  `${name} context`,
                  localBindings
                );
              }
            }
          }

          for (const specifier of statement.specifiers) {
            const exportedName = getIdentifierName(specifier.exported);
            if (!exportedName || !HTTP_METHODS.has(exportedName)) continue;

            const localName = getIdentifierName(specifier.local);
            const fn = localName ? functions.get(localName) : undefined;
            if (fn) {
              reportParameter(
                fn.params[1],
                "RouteContext",
                `${exportedName} context`,
                localBindings
              );
            }
          }
        }
      },
      after() {
        reportedParameters.clear();
      },
    };
  },
});
