import { describe, expect, it } from "vitest";

import { DEMO_DATA_MAX_AGE_MS, needsDemoReload, planDeploySetup } from "./plan";

const OWNER = "postgres://owner:secret@db.example.com/app";

describe(planDeploySetup, () => {
  it("skips when the login is managed by hand", () => {
    expect(
      planDeploySetup({
        ANALYST_DATABASE_URL: "postgres://x/y",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("ANALYST_DATABASE_URL"),
    });
  });

  it("skips without an owner connection", () => {
    expect(planDeploySetup({})).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("DATABASE_URL"),
    });
  });

  it.each([
    ["has no password", "postgres://owner@db.example.com/app", "password"],
    ["isn't a URL", "not a url", "valid connection string"],
  ])("skips when DATABASE_URL %s", (_name, url, reason) => {
    expect(planDeploySetup({ DATABASE_URL: url })).toMatchObject({
      action: "skip",
      reason: expect.stringContaining(reason),
    });
  });

  it("sets up the demo schema by default and seeds only when asked", () => {
    expect(planDeploySetup({ DATABASE_URL: OWNER })).toStrictEqual({
      action: "setup",
      baseRole: "analyst_readonly",
      ignoredSchemas: [],
      ownerUrl: OWNER,
      schemas: ["analytics"],
      seedDemoData: false,
      sharedSchemas: ["analytics"],
      teamRoles: [],
    });
    expect(
      planDeploySetup({ ANALYST_SEED_DEMO_DATA: "true", DATABASE_URL: OWNER })
    ).toMatchObject({ seedDemoData: true });
  });

  it("adds the demo schema to custom schemas while seeding", () => {
    expect(
      planDeploySetup({
        ANALYST_SCHEMAS: "billing, crm",
        ANALYST_SEED_DEMO_DATA: "1",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({ schemas: ["billing", "crm", "analytics"] });
    expect(
      planDeploySetup({ ANALYST_SCHEMAS: "billing", DATABASE_URL: OWNER })
    ).toMatchObject({ schemas: ["billing"] });
  });

  it("shares every explored schema unless ANALYST_SHARED_SCHEMAS narrows it", () => {
    expect(
      planDeploySetup({ ANALYST_SCHEMAS: "billing,crm", DATABASE_URL: OWNER })
    ).toMatchObject({
      schemas: ["billing", "crm"],
      sharedSchemas: ["billing", "crm"],
    });
    expect(
      planDeploySetup({
        ANALYST_SCHEMAS: "billing,crm",
        ANALYST_SHARED_SCHEMAS: "crm, Bad, public, other",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({
      ignoredSchemas: ["Bad", "public", "other"],
      schemas: ["billing", "crm"],
      sharedSchemas: ["crm"],
    });
  });

  it("shares the demo schema while seeding", () => {
    expect(
      planDeploySetup({
        ANALYST_SCHEMAS: "billing",
        ANALYST_SEED_DEMO_DATA: "true",
        ANALYST_SHARED_SCHEMAS: "analytics",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({
      schemas: ["billing", "analytics"],
      sharedSchemas: ["analytics"],
    });
  });

  it("collects valid team roles and drops unsafe names and schemas", () => {
    expect(
      planDeploySetup({
        ANALYST_DEFAULT_ROLE: "readers",
        ANALYST_ROLE_MAP: JSON.stringify({
          C1: "analyst_finance",
          U1: "",
          U2: "Bad Role",
          U3: "none",
        }),
        ANALYST_SCHEMAS: "billing,information_schema,pg_toast",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({
      baseRole: "readers",
      ignoredSchemas: ["information_schema", "pg_toast"],
      schemas: ["billing"],
      teamRoles: ["analyst_finance"],
    });
  });

  it("accepts public as a schema", () => {
    expect(
      planDeploySetup({
        ANALYST_SCHEMAS: "public,billing",
        ANALYST_SHARED_SCHEMAS: "public",
        DATABASE_URL: OWNER,
      })
    ).toMatchObject({
      ignoredSchemas: [],
      schemas: ["public", "billing"],
      sharedSchemas: ["public"],
    });
  });

  it("ignores a role map that isn't a JSON object", () => {
    expect(
      planDeploySetup({ ANALYST_ROLE_MAP: "{nope", DATABASE_URL: OWNER })
    ).toMatchObject({ teamRoles: [] });
  });
});

describe(needsDemoReload, () => {
  const now = new Date("2026-10-11T00:00:00Z");

  it("reloads missing or stale demo data only", () => {
    expect(needsDemoReload(null, now)).toBe(true);
    expect(
      needsDemoReload(new Date(now.getTime() - DEMO_DATA_MAX_AGE_MS - 1), now)
    ).toBe(true);
    expect(needsDemoReload(new Date(now.getTime() - 60_000), now)).toBe(false);
  });
});
