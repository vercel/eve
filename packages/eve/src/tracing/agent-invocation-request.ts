export type TracedAgentInvocationRequest<T extends object> = T & {
  readonly parentActionCallId?: string;
};

export function withAgentInvocationParent<T extends object>(
  request: T,
  parentActionCallId: string | undefined,
): TracedAgentInvocationRequest<T> {
  return parentActionCallId === undefined ? request : { ...request, parentActionCallId };
}

export function readAgentInvocationParent(request: object): string | undefined {
  const parentActionCallId = Reflect.get(request, "parentActionCallId");
  return typeof parentActionCallId === "string" && parentActionCallId.length > 0
    ? parentActionCallId
    : undefined;
}

export function withoutAgentInvocationParent<T extends object>(
  request: TracedAgentInvocationRequest<T>,
): T {
  const { parentActionCallId: _parentActionCallId, ...legacyRequest } = request;
  return legacyRequest as T;
}
