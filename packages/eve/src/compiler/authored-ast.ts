import { readFile } from "node:fs/promises";

import { parseWorkflowSourceAst } from "#internal/workflow-bundle/workflow-source-ast.js";

export interface AstNode {
  readonly [key: string]: unknown;
  readonly type?: unknown;
}

export async function readAuthoredAst(
  sourcePath: string,
  mentions: string,
): Promise<AstNode | undefined> {
  const source = await readFile(sourcePath, "utf8");
  if (!source.includes(mentions)) return undefined;
  return (await parseWorkflowSourceAst(sourcePath, source)) as AstNode;
}

export function visitAst(node: unknown, onNode: (node: AstNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, onNode);
    return;
  }
  const record = node as AstNode;
  if (typeof record.type === "string") onNode(record);
  for (const [key, value] of Object.entries(record)) {
    if (key !== "parent" && typeof value === "object") visitAst(value, onNode);
  }
}

const EXPRESSION_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

export function unwrapExpression(node: unknown): AstNode | undefined {
  let current = node;
  while (
    current !== null &&
    typeof current === "object" &&
    EXPRESSION_WRAPPERS.has((current as AstNode).type as string)
  ) {
    current = (current as AstNode).expression;
  }
  return current !== null && typeof current === "object" ? (current as AstNode) : undefined;
}

export function stringLiteral(node: unknown): string | undefined {
  const value = unwrapExpression(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  const quasis = value?.quasis as readonly { value: { cooked?: string } }[] | undefined;
  return value?.type === "TemplateLiteral" && quasis?.length === 1
    ? quasis[0]!.value.cooked
    : undefined;
}

export function propertyName(node: AstNode): string | undefined {
  const key = node.key as AstNode | undefined;
  if (node.computed === true) return stringLiteral(key);
  return key?.type === "Identifier" ? (key.name as string) : stringLiteral(key);
}

export function isFunctionNode(node: AstNode | undefined): boolean {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}
