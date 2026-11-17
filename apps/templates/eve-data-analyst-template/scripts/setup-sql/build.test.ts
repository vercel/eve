import { describe, expect, it } from "vitest";

import { buildSetupSql } from "./build";

const options = {
  baseRole: "analyst_readonly",
  login: "eve_analyst",
  password: "abcdefghijklmnop_1234",
  schemas: ["analytics"],
  setPassword: false,
  sharedSchemas: ["analytics"],
  teamRoles: [],
};

describe(buildSetupSql, () => {
  it("grants the base role read access to each shared schema", () => {
    const sql = buildSetupSql({
      ...options,
      schemas: ["analytics", "billing"],
      sharedSchemas: ["analytics", "billing"],
    });
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA analytics, billing TO analyst_readonly;"
    );
    expect(sql).toContain(
      "GRANT SELECT ON ALL TABLES IN SCHEMA analytics, billing TO analyst_readonly;"
    );
    expect(sql).toContain("CREATE ROLE analyst_readonly NOLOGIN;");
  });

  it("grants the public schema like any other", () => {
    const sql = buildSetupSql({
      ...options,
      schemas: ["public", "billing"],
      sharedSchemas: ["public"],
    });
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO analyst_readonly;");
    expect(sql).toContain(
      "-- REVOKE USAGE ON SCHEMA billing FROM analyst_readonly;"
    );
  });

  it("grants nothing in restricted schemas and points team roles at them", () => {
    const sql = buildSetupSql({
      ...options,
      schemas: ["analytics", "billing", "hr"],
      sharedSchemas: ["analytics"],
      teamRoles: ["analyst_finance"],
    });
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA analytics TO analyst_readonly;"
    );
    expect(sql).toContain(
      "GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO analyst_readonly;"
    );
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO analyst_readonly;"
    );
    expect(sql).not.toMatch(/^(?!--)[^\n]*\b(?:billing|hr)\b/mu);
    expect(sql).toContain(
      "-- GRANT USAGE ON SCHEMA billing, hr TO analyst_finance;"
    );
    expect(sql).toContain(
      "-- REVOKE SELECT ON ALL TABLES IN SCHEMA billing, hr FROM analyst_readonly;"
    );
  });

  it("explains that running it again re-grants every existing table", () => {
    const sql = buildSetupSql(options);
    expect(sql).toContain(
      "Running this again re-grants each one, which undoes a\n-- REVOKE on a single table."
    );
  });

  it("creates a NOINHERIT, read-only login that can only switch into analyst roles", () => {
    const sql = buildSetupSql({
      ...options,
      teamRoles: ["analyst_finance", "analyst_finance", "analyst_readonly"],
    });
    expect(sql).toContain(
      "CREATE ROLE eve_analyst LOGIN NOINHERIT PASSWORD 'abcdefghijklmnop_1234';"
    );
    expect(sql).toContain(
      "GRANT analyst_readonly, analyst_finance TO eve_analyst;"
    );
    expect(sql).toContain(
      "ALTER ROLE eve_analyst SET default_transaction_read_only = on;"
    );
    expect(sql).toContain(
      "CREATE ROLE analyst_finance NOLOGIN IN ROLE analyst_readonly;"
    );
    expect(sql).not.toMatch(/GRANT (?:USAGE|SELECT)[^\n]*TO eve_analyst/u);
  });

  it("is idempotent and only resets the password when asked", () => {
    const sql = buildSetupSql(options);
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eve_analyst')"
    );
    expect(sql).not.toContain("ALTER ROLE eve_analyst PASSWORD");
    expect(buildSetupSql({ ...options, setPassword: true })).toContain(
      "ALTER ROLE eve_analyst PASSWORD 'abcdefghijklmnop_1234';"
    );
  });

  it("keeps the set_config revoke commented out", () => {
    expect(buildSetupSql(options)).toContain(
      "\n-- REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;"
    );
  });

  it.each([
    [{ baseRole: "Analyst" }, "Default role"],
    [{ login: "eve-analyst" }, "Login role"],
    [{ schemas: ["information_schema"] }, "Schema"],
    [{ baseRole: "public" }, "Default role"],
    [{ teamRoles: ["none"] }, "ANALYST_ROLE_MAP role"],
    [{ login: "analyst_readonly" }, "must differ"],
    [{ password: "short" }, "password"],
    [{ password: "has'quote-abcdefghijk" }, "password"],
    [{ sharedSchemas: ["Billing"] }, "Schema"],
    [{ sharedSchemas: ["billing"] }, "must also be listed in ANALYST_SCHEMAS"],
    [{ schemas: [], sharedSchemas: [] }, "at least one shared schema"],
    [{ sharedSchemas: [] }, "at least one shared schema"],
  ])("rejects unsafe input %#", (override, message) => {
    expect(() => buildSetupSql({ ...options, ...override })).toThrow(message);
  });
});
