import type {
  DynamicSchedulesDefinition,
  ScheduleNamedScope,
} from "#public/schedules/subscription.js";

type AnyDefinition = DynamicSchedulesDefinition<any, any, any>;

const built = new WeakMap<object, Map<string, AnyDefinition>>();

/** The stored collection name of a definition's named scope: its `id`, or `<definition>/<scope>`. */
export function namedScopeCollectionName(
  definitionName: string,
  scopeName: string,
  scope: ScheduleNamedScope<any, any>,
): string {
  return (typeof scope === "function" ? undefined : scope.id) ?? `${definitionName}/${scopeName}`;
}

/**
 * The definition one named scope stands for: the shared definition, with that scope's resolver
 * and what it does differently. Built once per scope, so every load of the module reaches the
 * same object and `schedules(definition, { scope })` binds what the runtime stamped.
 */
export function namedScopeDefinition(definition: AnyDefinition, scopeName: string): AnyDefinition {
  const entry = definition.scopes?.[scopeName];
  if (entry === undefined)
    throw new Error(
      `Dynamic schedules definition has no scope "${scopeName}". Its scopes are: ${Object.keys(definition.scopes ?? {}).join(", ") || "none"}.`,
    );
  let scopes = built.get(definition);
  if (scopes === undefined) {
    scopes = new Map();
    built.set(definition, scopes);
  }
  const existing = scopes.get(scopeName);
  if (existing !== undefined) return existing;

  const scope = typeof entry === "function" ? { resolve: entry } : entry;
  const { scopes: _scopes, id: _id, ...shared } = definition;
  const preparePayload = scope.preparePayload ?? shared.preparePayload;
  const scoped: AnyDefinition = {
    ...shared,
    ...(scope.description !== undefined && { description: scope.description }),
    ...(scope.run !== undefined && { run: scope.run }),
    ...(scope.approval !== undefined && { approval: { ...shared.approval, ...scope.approval } }),
    // Callbacks learn which scope they act for, so shared ones needn't be told apart by payload.
    ...(preparePayload !== undefined && {
      preparePayload: (payload: unknown, context: object) =>
        preparePayload(payload, { ...context, scopeName } as never),
    }),
    scope: (context) => scope.resolve({ ...context, scopeName }),
  };
  scopes.set(scopeName, scoped);
  return scoped;
}
