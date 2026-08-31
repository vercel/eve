export type WorkflowDirective = "use step" | "use workflow";

export interface DirectiveStatementNode {
  readonly directive?: unknown;
  readonly expression?: unknown;
  readonly type?: unknown;
}

// Some parsers record a directive prologue on the statement; others leave a
// plain string-literal expression.
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
