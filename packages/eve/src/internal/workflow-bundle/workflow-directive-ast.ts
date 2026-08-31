export type WorkflowDirective = "use step" | "use workflow";

/** The shape of a parsed statement this module needs, whatever the caller's AST type. */
export interface DirectiveStatementNode {
  readonly directive?: unknown;
  readonly expression?: unknown;
  readonly type?: unknown;
}

/**
 * Reads a Workflow directive off the first statement of a function body. The
 * parser records a directive prologue on the statement; a string literal that
 * is not in prologue position still counts, so a directive following a
 * comment or a blank expression is recognized the same way.
 */
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
