import type { StubScope } from "#tool-stubs/types.js";

export function stubToolPath(scope: StubScope | undefined, tool: string): string {
  return scope?.agentPath === undefined ? tool : `${scope.agentPath}/${tool}`;
}

export function findStubTarget(scope: StubScope | undefined, tool: string) {
  if (scope === undefined) return undefined;
  tool = stubToolPath(scope, tool);
  return scope.rules.some((rule) => rule.tool === tool) ? { scope, tool } : undefined;
}

export function stubCallId(sessionId: string, turnId: string, callId: string): string {
  return `${sessionId}:${turnId}:${callId}`;
}
