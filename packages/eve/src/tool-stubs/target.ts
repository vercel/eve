import type { StubScope } from "#tool-stubs/types.js";

/** Qualify names for stub matching without changing the names sent to the model. */
export function stubToolPath(scope: StubScope | undefined, tool: string): string {
  return scope?.agentPath === undefined ? tool : `${scope.agentPath}/${tool}`;
}

export function findStubTarget(scope: StubScope | undefined, tool: string) {
  if (scope === undefined) return undefined;
  tool = stubToolPath(scope, tool);
  return scope.rules.some((rule) => rule.tool === tool) ? { scope, tool } : undefined;
}

/** Whether a rule for the qualified `tool` has an outcome that ends the turn. */
export function stubMayEndTurn(scope: StubScope, tool: string): boolean {
  return scope.rules.some(
    (rule) =>
      rule.tool === tool &&
      (rule.outcomes ?? [rule.outcome!]).some((outcome) => outcome.endsTurn === true),
  );
}

export function stubCallId(sessionId: string, turnId: string, callId: string): string {
  return `${sessionId}:${turnId}:${callId}`;
}
