import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral } from "../../shared/literals.ts";

const productionLayers = ["agent", "app", "db", "shared", "web"] as const;
type ProductionLayer = (typeof productionLayers)[number];

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

const forbiddenDependencies = {
  agent: new Set<ProductionLayer>(["app", "web"]),
  app: new Set<ProductionLayer>(["agent"]),
  db: new Set<ProductionLayer>(["agent", "app", "web"]),
  shared: new Set<ProductionLayer>(["agent", "app", "db", "web"]),
  web: new Set<ProductionLayer>(["agent", "app"]),
} satisfies Record<ProductionLayer, ReadonlySet<ProductionLayer>>;

function productionLayerForPath(
  filePath: string,
  repositoryRoot: string
): ProductionLayer | undefined {
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath === path.join(repositoryRoot, "proxy.ts")) return "web";

  const relativePath = path.relative(repositoryRoot, normalizedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const [root] = relativePath.split(path.sep);
  return productionLayers.find((candidate) => candidate === root);
}

function importedProductionLayer(
  importer: string,
  source: string,
  repositoryRoot: string
): ProductionLayer | undefined {
  if (source.startsWith(".")) {
    return productionLayerForPath(
      path.resolve(path.dirname(importer), source),
      repositoryRoot
    );
  }

  const match = /^@(agent|app|db|shared|web)(?:\/(.*))?$/u.exec(source);
  const aliasRoot = match?.[1];
  if (!aliasRoot) return undefined;

  return productionLayerForPath(
    path.resolve(repositoryRoot, `${aliasRoot}/${match[2] ?? ""}`),
    repositoryRoot
  );
}

function moduleMockSource(
  node: ESTree.CallExpression
): ESTree.Node | undefined {
  const callee = node.callee;
  if (
    !("object" in callee) ||
    !("property" in callee) ||
    !("computed" in callee) ||
    callee.object.type !== "Identifier" ||
    (callee.object.name !== "vi" && callee.object.name !== "jest")
  ) {
    return undefined;
  }

  const method = callee.computed
    ? isStringLiteral(callee.property)
      ? callee.property.value
      : undefined
    : callee.property.type === "Identifier"
      ? callee.property.name
      : undefined;
  if (!method || !moduleMockMethods.has(method)) return undefined;

  const [source] = node.arguments;
  return source && isStringLiteral(source) ? source : undefined;
}

export const noForbiddenLayerImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep production dependencies directed away from agent and web ownership toward shared contracts and persistence.",
    },
    messages: {
      forbiddenImport:
        "{{owner}} cannot import {{dependency}} under the repository dependency direction.",
    },
    schema: [],
  },
  createOnce(context) {
    let repositoryRoot = "";
    let importer = "";
    let owner: ProductionLayer | undefined;

    const checkImport = (node: ESTree.Node, source: string) => {
      if (!owner) return;
      const dependency = importedProductionLayer(
        importer,
        source,
        repositoryRoot
      );
      if (!dependency || !forbiddenDependencies[owner].has(dependency)) return;

      context.report({
        node,
        messageId: "forbiddenImport",
        data: { owner, dependency },
      });
    };

    return {
      before() {
        repositoryRoot = path.resolve(context.cwd);
        importer = path.resolve(context.filename);
        owner = productionLayerForPath(importer, repositoryRoot);
      },
      ExportAllDeclaration(node) {
        checkImport(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkImport(node.source, node.source.value);
      },
      ImportDeclaration(node) {
        checkImport(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (isStringLiteral(node.source)) {
          checkImport(node.source, node.source.value);
        }
      },
      CallExpression(node) {
        const source = moduleMockSource(node);
        if (source && isStringLiteral(source)) {
          checkImport(source, source.value);
        }
      },
    };
  },
});
