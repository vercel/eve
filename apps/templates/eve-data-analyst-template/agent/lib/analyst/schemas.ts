import { DEMO_SCHEMA, isEnabled } from "#lib/analyst/derived-login";

/** The explored and shared schema lists, before their names are validated. */
export interface SchemaLists {
  /** Schemas the agent explores, from `ANALYST_SCHEMAS`. */
  readonly schemas: readonly string[];
  /** Schemas every role can read, from `ANALYST_SHARED_SCHEMAS`. */
  readonly sharedSchemas: readonly string[];
}

/**
 * Splits a comma-separated list, trimming and deduplicating its items.
 *
 * @param value - Raw list, such as `analytics, billing`.
 * @returns The non-empty items in their original order.
 */
export const splitList = (value: string): string[] => [
  ...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ),
];

/* Appends the demo schema unless the list already has it. */
const withDemo = (names: readonly string[]): string[] =>
  names.includes(DEMO_SCHEMA) ? [...names] : [...names, DEMO_SCHEMA];

/**
 * Resolves the explored and shared schema lists the same way for the agent, the deploy step, and `db:setup-sql`.
 *
 * @param env - Environment variables: `ANALYST_SCHEMAS`, `ANALYST_SHARED_SCHEMAS`, and `ANALYST_SEED_DEMO_DATA`.
 * @returns Both lists, with defaults applied.
 * @remarks Names aren't validated here, so each caller can report or drop bad names its own way. A blank value counts as unset. `ANALYST_SCHEMAS` defaults to the demo schema, and `ANALYST_SHARED_SCHEMAS` defaults to every explored schema. With `ANALYST_SEED_DEMO_DATA` on, the demo schema is appended to both lists, so it's always readable and the order of your own schemas in `search_path` stays the same.
 */
export const resolveSchemaLists = (
  env: Readonly<Record<string, string | undefined>>
): SchemaLists => {
  const schemas = splitList(env.ANALYST_SCHEMAS?.trim() || DEMO_SCHEMA);
  const shared = env.ANALYST_SHARED_SCHEMAS?.trim()
    ? splitList(env.ANALYST_SHARED_SCHEMAS)
    : schemas;
  return isEnabled(env.ANALYST_SEED_DEMO_DATA)
    ? { schemas: withDemo(schemas), sharedSchemas: withDemo(shared) }
    : { schemas, sharedSchemas: [...shared] };
};
