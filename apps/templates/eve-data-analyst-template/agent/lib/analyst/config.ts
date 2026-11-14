import { z } from "zod";

import {
  DEMO_SCHEMA,
  deriveAnalystUrl,
  derivedLoginProblem,
  isEnabled,
} from "#lib/analyst/derived-login";
import { identifierSchema, schemaNameSchema } from "#lib/analyst/identifiers";
import { resolveSchemaLists, splitList } from "#lib/analyst/schemas";

/** Longest cell value returned to the model, matching the Slack table cell limit. */
export const MAX_CELL_CHARS = 500;

/** Approximate serialized size budget for one query result returned to the model. */
export const MAX_OUTPUT_CHARS = 60_000;

/* IANA names only; also keeps the value safe inside a quoted SQL literal. */
const TIMEZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

/**
 * Checks whether a value is an IANA time zone name the runtime recognizes.
 *
 * @param value - Candidate time zone, such as `UTC` or `America/New_York`.
 * @returns Whether the value is safe to use as a reporting time zone.
 */
export const isTimeZone = (value: string): boolean => {
  if (!TIMEZONE_NAME.test(value)) {
    return false;
  }
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
        .timeZone !== ""
    );
  } catch {
    return false;
  }
};

const roleMapSchema = z
  .string()
  .default("{}")
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: 'must be JSON like {"slack:T123:U456":"analyst_finance"}',
      });
      return z.NEVER;
    }
    const result = z
      .record(z.string(), z.union([identifierSchema, z.literal("")]))
      .safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: `${issue.path.join(".") || "value"} ${issue.message}`,
        });
      }
      return z.NEVER;
    }
    // A null-prototype map, so keys like "constructor" never resolve through Object.prototype.
    // SAFETY: Object.create(null) returns an empty object, which every Record<string, string> admits.
    return Object.assign(
      Object.create(null) as Record<string, string>,
      result.data
    );
  });

const schemaListSchema = z
  .array(schemaNameSchema)
  .min(1, "must list at least one schema");

const schema = z.object({
  ANALYST_APPROVAL_COST: z.coerce.number().positive().default(1_000_000),
  ANALYST_DATABASE_URL: z
    .string({
      error:
        "is required. Set DATABASE_URL so the agent can derive its read-only login, or set ANALYST_DATABASE_URL yourself",
    })
    .refine((value) => {
      try {
        return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, "must be a postgres:// or postgresql:// connection string"),
  ANALYST_DEFAULT_ROLE: z
    .union([identifierSchema, z.literal("")])
    .default("analyst_readonly"),
  ANALYST_MAX_ROWS: z.coerce.number().int().min(10).max(5000).default(500),
  ANALYST_ROLE_MAP: roleMapSchema,
  ANALYST_SCHEMAS: z
    .string()
    .default(DEMO_SCHEMA)
    .transform(splitList)
    .pipe(schemaListSchema),
  ANALYST_SEED_DEMO_DATA: z.string().optional().transform(isEnabled),
  ANALYST_SHARED_SCHEMAS: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : splitList(value)))
    .pipe(schemaListSchema.optional()),
  ANALYST_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(20_000),
  ANALYST_TIMEZONE: z
    .string()
    .default("UTC")
    .refine(
      isTimeZone,
      "must be an IANA time zone such as UTC or America/New_York"
    ),
});

/* Blank values mean "use the default", except a blank default role, which turns on allowlist mode. */
const withoutBlankValues = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        key.startsWith("ANALYST_") &&
        (value?.trim() || key === "ANALYST_DEFAULT_ROLE")
    )
  );

/* The read-only login's connection: set explicitly, or derived from the owner connection the deploy step used. */
const withDerivedLogin = (
  env: NodeJS.ProcessEnv,
  settings: Record<string, string | undefined>
) => {
  const ownerUrl = env.DATABASE_URL?.trim();
  if (settings.ANALYST_DATABASE_URL || !ownerUrl) {
    return { deriveError: null, settings };
  }
  const deriveError = derivedLoginProblem(ownerUrl);
  return deriveError
    ? { deriveError, settings }
    : {
        deriveError,
        settings: {
          ...settings,
          ANALYST_DATABASE_URL: deriveAnalystUrl(ownerUrl),
        },
      };
};

/* Shared schemas outside ANALYST_SCHEMAS, checked on its own so it's reported alongside every other problem. */
const unlistedSharedSchemas = (
  settings: Record<string, string | undefined>
): string[] => {
  const { schemas, sharedSchemas } = resolveSchemaLists(settings);
  return sharedSchemas.filter((name) => !schemas.includes(name));
};

/** Validated warehouse settings read from environment variables. */
export type AnalystConfig = Omit<
  z.infer<typeof schema>,
  "ANALYST_SHARED_SCHEMAS"
> & {
  /**
   * Schemas whose tables the deploy step grants to the base role, always a subset of `ANALYST_SCHEMAS`.
   * @remarks Defaults to every schema in `ANALYST_SCHEMAS`. Schemas left out are restricted: setup grants nothing in them, so only roles an admin grants can read their tables.
   */
  readonly ANALYST_SHARED_SCHEMAS: string[];
};

/* Resolves both schema lists the way the deploy step and db:setup-sql do. */
const withSchemaLists = (
  data: z.infer<typeof schema>,
  settings: Record<string, string | undefined>
): AnalystConfig => {
  const { schemas, sharedSchemas } = resolveSchemaLists(settings);
  return {
    ...data,
    ANALYST_SCHEMAS: [...schemas],
    ANALYST_SHARED_SCHEMAS: [...sharedSchemas],
  };
};

/**
 * Parses warehouse settings from an environment object.
 *
 * @param env - Environment variables to read: `ANALYST_*` keys, plus `DATABASE_URL` when `ANALYST_DATABASE_URL` is unset. Blank values other than `ANALYST_DEFAULT_ROLE` fall back to defaults.
 * @returns Validated settings with defaults applied.
 * @throws {@link Error} Listing every invalid or missing setting at once, including why the login can't be derived from `DATABASE_URL`, such as a missing password.
 * @remarks `DATABASE_URL` is only used to derive the read-only login's connection string; the agent never connects with it. `ANALYST_SHARED_SCHEMAS` defaults to `ANALYST_SCHEMAS` and must be a subset of it. With `ANALYST_SEED_DEMO_DATA` on, the demo schema joins both lists, so it's always readable.
 */
export const parseAnalystConfig = (env: NodeJS.ProcessEnv): AnalystConfig => {
  const { deriveError, settings } = withDerivedLogin(
    env,
    withoutBlankValues(env)
  );
  const result = schema.safeParse(settings);
  const unlisted = unlistedSharedSchemas(settings);
  if (result.success && unlisted.length === 0) {
    return withSchemaLists(result.data, settings);
  }
  // DATABASE_URL is set but unusable, so its reason replaces the generic "ANALYST_DATABASE_URL is required".
  const problems = [
    ...(deriveError ? [`  - DATABASE_URL: ${deriveError}`] : []),
    ...(result.error?.issues ?? [])
      .filter(
        (issue) =>
          !(deriveError && issue.path.join(".") === "ANALYST_DATABASE_URL")
      )
      .map((issue) => `  - ${issue.path.join(".") || "env"}: ${issue.message}`),
    ...(unlisted.length > 0
      ? [
          `  - ANALYST_SHARED_SCHEMAS: ${unlisted.join(", ")} must also be listed in ANALYST_SCHEMAS`,
        ]
      : []),
  ].join("\n");
  throw new Error(
    `The data analyst isn't configured yet:\n${problems}\nSee .env.example, or run \`pnpm db:doctor\` for a full check.`
  );
};

/**
 * Reads warehouse settings from the environment.
 *
 * @returns Validated settings from `process.env`.
 * @throws {@link Error} When settings are missing or invalid.
 * @remarks Validation runs when a tool needs it rather than at import, so `eve build` works before the database is configured. Parsing is cheap, so settings aren't cached.
 */
export const analystConfig = (): AnalystConfig =>
  parseAnalystConfig(process.env);
