import { describe, expect, it } from "vitest";

import {
  identifierSchema,
  isSafeIdentifier,
  isSafeSchemaName,
  schemaNameSchema,
} from "./identifiers";

describe(isSafeIdentifier, () => {
  it.each([
    "analytics",
    "analyst_readonly",
    "_private",
    "team_2",
    "a".repeat(63),
  ])("accepts %j", (value) => {
    expect(isSafeIdentifier(value)).toBe(true);
  });

  it.each([
    "",
    "Analytics",
    "2fast",
    "analyst-readonly",
    'analyst"; drop',
    "analyst readonly",
    "analyst;",
    "a".repeat(64),
    "none",
    "public",
    "current_user",
    "information_schema",
    "pg_read_all_data",
    "pg_catalog",
  ])("rejects %j", (value) => {
    expect(isSafeIdentifier(value)).toBe(false);
    expect(identifierSchema.safeParse(value).success).toBe(false);
  });
});

describe(isSafeSchemaName, () => {
  it.each(["public", "analytics", "_private"])("accepts %j", (value) => {
    expect(isSafeSchemaName(value)).toBe(true);
    expect(schemaNameSchema.safeParse(value).success).toBe(true);
  });

  it.each(["Public", "information_schema", "pg_catalog", "none", "a;b"])(
    "rejects %j",
    (value) => {
      expect(isSafeSchemaName(value)).toBe(false);
      expect(schemaNameSchema.safeParse(value).success).toBe(false);
    }
  );
});
