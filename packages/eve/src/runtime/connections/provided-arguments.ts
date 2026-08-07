import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/** Resolves and merges application-provided arguments, with application values winning. */
export async function resolveProvidedArguments(input: {
  readonly args: unknown;
  readonly connection: ResolvedConnectionDefinition;
  readonly toolName: string;
}): Promise<Record<string, unknown>> {
  if (!isObject(input.args)) {
    throw new Error(
      `Tool "${input.toolName}" in connection "${input.connection.connectionName}" expected object arguments.`,
    );
  }

  const definition = input.connection.toolCall?.providedArguments;
  if (definition === undefined || Object.keys(definition).length === 0) {
    return input.args;
  }

  let context:
    | (ReturnType<typeof buildCallbackContext> & { readonly toolName: string })
    | undefined;
  const getContext = () =>
    (context ??= {
      ...buildCallbackContext(),
      toolName: input.toolName,
    });
  const provided: Record<string, JsonValue> = {};

  for (const [key, configuredValue] of Object.entries(definition)) {
    const value =
      typeof configuredValue === "function"
        ? await configuredValue(getContext())
        : await configuredValue;
    try {
      provided[key] = parseJsonValue(value);
    } catch {
      throw new Error(
        `Connection "${input.connection.connectionName}" provided argument "${key}" must resolve to a JSON-serializable value.`,
      );
    }
  }

  return { ...input.args, ...provided };
}

/** Removes application-provided top-level properties from a remote tool schema. */
export function omitProvidedArgumentsFromSchema<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  names: readonly string[],
): TSchema {
  if (names.length === 0) {
    return schema;
  }

  const omitted = new Set(names);
  const projected: Record<string, unknown> = { ...schema };

  if (isObject(schema.properties)) {
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(([name]) => !omitted.has(name)),
    );
  }
  if (Array.isArray(schema.required)) {
    projected.required = schema.required.filter(
      (name) => typeof name !== "string" || !omitted.has(name),
    );
  }

  return projected as TSchema;
}
