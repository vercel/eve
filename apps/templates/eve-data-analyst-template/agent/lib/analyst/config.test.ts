import { describe, expect, it } from "vitest";

import { parseAnalystConfig } from "./config";

const URL = "postgres://eve_analyst:secret@db.example.com:5432/app";
const parse = (env: Record<string, string> = {}) =>
  parseAnalystConfig({ ANALYST_DATABASE_URL: URL, ...env });

describe(parseAnalystConfig, () => {
  it("applies defaults", () => {
    expect(parse()).toMatchObject({
      ANALYST_APPROVAL_COST: 1_000_000,
      ANALYST_DATABASE_URL: URL,
      ANALYST_DEFAULT_ROLE: "analyst_readonly",
      ANALYST_MAX_ROWS: 500,
      ANALYST_ROLE_MAP: {},
      ANALYST_SCHEMAS: ["analytics"],
      ANALYST_SHARED_SCHEMAS: ["analytics"],
      ANALYST_STATEMENT_TIMEOUT_MS: 20_000,
      ANALYST_TIMEZONE: "UTC",
    });
  });

  it("treats blank values as unset", () => {
    expect(
      parse({
        ANALYST_MAX_ROWS: "",
        ANALYST_SCHEMAS: " ",
        ANALYST_TIMEZONE: "",
      })
    ).toMatchObject({
      ANALYST_MAX_ROWS: 500,
      ANALYST_SCHEMAS: ["analytics"],
      ANALYST_TIMEZONE: "UTC",
    });
  });

  it("keeps a blank default role as allowlist mode", () => {
    expect(parse({ ANALYST_DEFAULT_ROLE: "" }).ANALYST_DEFAULT_ROLE).toBe("");
  });

  it("trims and deduplicates schemas", () => {
    expect(
      parse({ ANALYST_SCHEMAS: " analytics, billing ,analytics,," })
        .ANALYST_SCHEMAS
    ).toStrictEqual(["analytics", "billing"]);
  });

  it("accepts public as a schema but not as a role", () => {
    expect(
      parse({
        ANALYST_SCHEMAS: "public,billing",
        ANALYST_SHARED_SCHEMAS: "public",
      })
    ).toMatchObject({
      ANALYST_SCHEMAS: ["public", "billing"],
      ANALYST_SHARED_SCHEMAS: ["public"],
    });
    expect(() => parse({ ANALYST_DEFAULT_ROLE: "public" })).toThrow(
      "ANALYST_DEFAULT_ROLE"
    );
    expect(() =>
      parse({ ANALYST_ROLE_MAP: JSON.stringify({ U123: "public" }) })
    ).toThrow("ANALYST_ROLE_MAP");
  });

  it.each(["Analytics", "information_schema", "pg_catalog", "a;b", ","])(
    "rejects the schema list %j",
    (value) => {
      expect(() => parse({ ANALYST_SCHEMAS: value })).toThrow(
        "ANALYST_SCHEMAS"
      );
    }
  );

  it("parses role maps, keeping blank roles as denials", () => {
    const { ANALYST_ROLE_MAP } = parse({
      ANALYST_ROLE_MAP: JSON.stringify({
        "slack:T1:U1": "analyst_finance",
        "slack:T1:U2": "",
      }),
    });
    expect(ANALYST_ROLE_MAP).toStrictEqual(
      Object.assign(Object.create(null), {
        "slack:T1:U1": "analyst_finance",
        "slack:T1:U2": "",
      })
    );
  });

  it("never resolves role map keys through the object prototype", () => {
    const { ANALYST_ROLE_MAP } = parse();
    expect(ANALYST_ROLE_MAP.constructor).toBeUndefined();
    expect(Object.hasOwn(ANALYST_ROLE_MAP, "toString")).toBe(false);
  });

  it.each([
    ["invalid JSON", "{nope", "must be JSON"],
    ["an array", '["analyst"]', "ANALYST_ROLE_MAP"],
    ["an unsafe role", '{"slack:T1:U1":"none"}', "slack:T1:U1"],
    ["a quoted role", '{"slack:T1:U1":"a\\"; drop"}', "slack:T1:U1"],
  ])("rejects a role map with %s", (_name, value, message) => {
    expect(() => parse({ ANALYST_ROLE_MAP: value })).toThrow(message);
  });

  it.each([
    ["ANALYST_APPROVAL_COST", "0"],
    ["ANALYST_MAX_ROWS", "9"],
    ["ANALYST_MAX_ROWS", "5001"],
    ["ANALYST_STATEMENT_TIMEOUT_MS", "999"],
    ["ANALYST_STATEMENT_TIMEOUT_MS", "1.5"],
    ["ANALYST_TIMEZONE", "Mars/Olympus"],
    ["ANALYST_TIMEZONE", "UTC'; drop"],
    ["ANALYST_DEFAULT_ROLE", "public"],
  ])("rejects %s=%j", (key, value) => {
    expect(() => parse({ [key]: value })).toThrow(key);
  });

  it("accepts IANA time zones", () => {
    expect(
      parse({ ANALYST_TIMEZONE: "America/New_York" }).ANALYST_TIMEZONE
    ).toBe("America/New_York");
  });

  it.each(["", "mysql://db/app", "not a url"])(
    "rejects the database URL %j",
    (value) => {
      expect(() => parseAnalystConfig({ ANALYST_DATABASE_URL: value })).toThrow(
        "ANALYST_DATABASE_URL"
      );
    }
  );

  it("accepts postgresql:// URLs", () => {
    expect(() =>
      parseAnalystConfig({ ANALYST_DATABASE_URL: "postgresql://db/app" })
    ).not.toThrow();
  });

  it("shares every explored schema unless ANALYST_SHARED_SCHEMAS narrows it", () => {
    expect(
      parse({ ANALYST_SCHEMAS: "billing,crm" }).ANALYST_SHARED_SCHEMAS
    ).toStrictEqual(["billing", "crm"]);
    expect(
      parse({
        ANALYST_SCHEMAS: "billing,crm",
        ANALYST_SHARED_SCHEMAS: " crm, crm,",
      })
    ).toMatchObject({
      ANALYST_SCHEMAS: ["billing", "crm"],
      ANALYST_SHARED_SCHEMAS: ["crm"],
    });
    expect(
      parse({ ANALYST_SCHEMAS: "billing", ANALYST_SHARED_SCHEMAS: " " })
        .ANALYST_SHARED_SCHEMAS
    ).toStrictEqual(["billing"]);
  });

  it.each(["Bad", "information_schema", ","])(
    "rejects the shared schema list %j",
    (value) => {
      expect(() => parse({ ANALYST_SHARED_SCHEMAS: value })).toThrow(
        /ANALYST_SHARED_SCHEMAS(?:\.0)?: must/u
      );
    }
  );

  it("rejects shared schemas that ANALYST_SCHEMAS leaves out", () => {
    expect(() =>
      parse({ ANALYST_SCHEMAS: "billing", ANALYST_SHARED_SCHEMAS: "crm" })
    ).toThrow(
      "ANALYST_SHARED_SCHEMAS: crm must also be listed in ANALYST_SCHEMAS"
    );
  });

  it("lists every problem in one error", () => {
    expect(() =>
      parseAnalystConfig({ ANALYST_MAX_ROWS: "1", ANALYST_SCHEMAS: "Bad" })
    ).toThrow(
      /ANALYST_DATABASE_URL[\s\S]*ANALYST_MAX_ROWS[\s\S]*ANALYST_SCHEMAS/u
    );
  });

  it("reports an unlisted shared schema alongside other problems", () => {
    expect(() =>
      parseAnalystConfig({
        ANALYST_MAX_ROWS: "1",
        ANALYST_SCHEMAS: "billing",
        ANALYST_SHARED_SCHEMAS: "crm",
      })
    ).toThrow(
      /ANALYST_DATABASE_URL[\s\S]*ANALYST_MAX_ROWS[\s\S]*ANALYST_SHARED_SCHEMAS: crm/u
    );
  });

  it("derives the read-only login from DATABASE_URL when ANALYST_DATABASE_URL is unset", () => {
    const config = parseAnalystConfig({
      DATABASE_URL: URL.replace("eve_analyst", "postgres"),
    });
    expect(config.ANALYST_DATABASE_URL).toMatch(
      /^postgres:\/\/eve_analyst:[\w-]+@db\.example\.com:5432\/app$/u
    );
  });

  it("keeps a pooler's user name suffix on the derived login", () => {
    const config = parseAnalystConfig({
      DATABASE_URL:
        "postgres://postgres.abcdefgh:secret@pooler.example.com:6543/postgres",
    });
    expect(config.ANALYST_DATABASE_URL).toMatch(
      /^postgres:\/\/eve_analyst\.abcdefgh:[\w-]+@pooler\.example\.com:6543\/postgres$/u
    );
  });

  it("explains a DATABASE_URL without a password and still lists other problems", () => {
    let message = "";
    try {
      parseAnalystConfig({
        ANALYST_MAX_ROWS: "1",
        DATABASE_URL: "postgres://postgres@db.example.com/app",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("DATABASE_URL: needs a password");
    expect(message).toContain("ANALYST_MAX_ROWS");
    expect(message).not.toContain("is required");
    expect(message).not.toContain("db.example.com");
  });

  it("explains a DATABASE_URL that isn't a connection string", () => {
    expect(() => parseAnalystConfig({ DATABASE_URL: "not a url" })).toThrow(
      "DATABASE_URL: isn't a valid connection string"
    );
  });

  it("prefers an explicit ANALYST_DATABASE_URL over the derived login", () => {
    expect(
      parseAnalystConfig({
        ANALYST_DATABASE_URL: URL,
        DATABASE_URL: "postgres://postgres:x@other/app",
      }).ANALYST_DATABASE_URL
    ).toBe(URL);
  });

  it("explains both options when neither connection is set", () => {
    expect(() => parseAnalystConfig({})).toThrow("Set DATABASE_URL");
  });

  it.each([
    ["1", true],
    ["TRUE", true],
    ["true", true],
    ["yes", false],
    ["0", false],
  ])("reads ANALYST_SEED_DEMO_DATA=%j as %s", (value, expected) => {
    expect(
      parse({ ANALYST_SEED_DEMO_DATA: value }).ANALYST_SEED_DEMO_DATA
    ).toBe(expected);
  });

  it("keeps the demo schema readable while demo data is on", () => {
    expect(
      parse({ ANALYST_SCHEMAS: "billing", ANALYST_SEED_DEMO_DATA: "true" })
        .ANALYST_SCHEMAS
    ).toStrictEqual(["billing", "analytics"]);
    expect(parse({ ANALYST_SCHEMAS: "billing" }).ANALYST_SCHEMAS).toStrictEqual(
      ["billing"]
    );
  });

  it("shares the demo schema while demo data is on", () => {
    expect(
      parse({
        ANALYST_SCHEMAS: "billing,crm",
        ANALYST_SEED_DEMO_DATA: "true",
        ANALYST_SHARED_SCHEMAS: "crm",
      })
    ).toMatchObject({
      ANALYST_SCHEMAS: ["billing", "crm", "analytics"],
      ANALYST_SHARED_SCHEMAS: ["crm", "analytics"],
    });
    expect(
      parse({
        ANALYST_SCHEMAS: "billing",
        ANALYST_SEED_DEMO_DATA: "true",
        ANALYST_SHARED_SCHEMAS: "analytics",
      }).ANALYST_SHARED_SCHEMAS
    ).toStrictEqual(["analytics"]);
  });
});
