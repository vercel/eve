import { z } from "zod";

/** Lowercase, unquoted Postgres identifier within the 63-byte name limit. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/* Names that are valid identifiers but change meaning in `SET ROLE` or `search_path`. */
const RESERVED = new Set([
  "all",
  "current_role",
  "current_user",
  "default",
  "information_schema",
  "none",
  "public",
  "session_user",
  "user",
]);

/**
 * Checks whether a value is safe to interpolate as a role or schema name.
 *
 * @param value - Candidate identifier from configuration.
 * @returns Whether the value is a lowercase identifier that is neither reserved nor a `pg_` system name.
 * @remarks `SET ROLE none` resets to the login role and `pg_*` names belong to Postgres, so both are rejected.
 */
export const isSafeIdentifier = (value: string): boolean =>
  IDENTIFIER.test(value) && !RESERVED.has(value) && !value.startsWith("pg_");

/** Zod schema for a role or schema name that may be interpolated into SQL. */
export const identifierSchema = z
  .string()
  .refine(
    isSafeIdentifier,
    "must be a lowercase Postgres identifier (a-z, 0-9, _), at most 63 characters, not reserved, and not starting with pg_"
  );

/**
 * Checks whether a value is safe to interpolate as a schema name.
 *
 * @param value - Candidate schema name from configuration.
 * @returns Whether the value passes {@link isSafeIdentifier}, or is `public`.
 * @remarks `public` is the most common schema and means the same thing in `search_path` and `GRANT ... ON SCHEMA`, so it's allowed here. It stays reserved as a role name, where it would grant to every role.
 */
export const isSafeSchemaName = (value: string): boolean =>
  value === "public" || isSafeIdentifier(value);

/** Zod schema for a schema name that may be interpolated into SQL. */
export const schemaNameSchema = z
  .string()
  .refine(
    isSafeSchemaName,
    "must be public or a lowercase Postgres identifier (a-z, 0-9, _), at most 63 characters, not reserved, and not starting with pg_"
  );
