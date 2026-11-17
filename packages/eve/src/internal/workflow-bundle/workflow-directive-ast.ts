export type WorkflowDirective = "use step" | "use workflow";

export function mayContainWorkflowDirective(source: string): boolean {
  return source.includes("use step") || source.includes("use workflow") || source.includes("\\");
}

export interface DirectiveStatementNode {
  readonly directive?: unknown;
  readonly expression?: unknown;
  readonly type?: unknown;
}

export function readWorkflowDirective(
  statement: DirectiveStatementNode | undefined,
): WorkflowDirective | undefined {
  const expression = statement?.expression as { type?: unknown; value?: unknown } | undefined;
  const value =
    statement?.directive ??
    (statement?.type === "ExpressionStatement" && expression?.type === "Literal"
      ? expression.value
      : undefined);
  return value === "use step" || value === "use workflow" ? value : undefined;
}
