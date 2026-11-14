import { describe, expect, it } from "vitest";

import { resolveSchemaLists, splitList } from "./schemas";

describe(splitList, () => {
  it("trims, drops blanks, and deduplicates in order", () => {
    expect(splitList(" billing, crm,,billing ")).toStrictEqual([
      "billing",
      "crm",
    ]);
  });
});

describe(resolveSchemaLists, () => {
  it("defaults to the demo schema and shares every explored schema", () => {
    expect(resolveSchemaLists({})).toStrictEqual({
      schemas: ["analytics"],
      sharedSchemas: ["analytics"],
    });
    expect(
      resolveSchemaLists({
        ANALYST_SCHEMAS: "public,billing",
        ANALYST_SHARED_SCHEMAS: " ",
      })
    ).toStrictEqual({
      schemas: ["public", "billing"],
      sharedSchemas: ["public", "billing"],
    });
  });

  it("keeps names as written, so callers can report bad ones", () => {
    expect(
      resolveSchemaLists({
        ANALYST_SCHEMAS: "billing",
        ANALYST_SHARED_SCHEMAS: "Bad,crm",
      })
    ).toStrictEqual({ schemas: ["billing"], sharedSchemas: ["Bad", "crm"] });
  });

  it("appends the demo schema to both lists while demo data is on", () => {
    expect(
      resolveSchemaLists({
        ANALYST_SCHEMAS: "billing",
        ANALYST_SEED_DEMO_DATA: "1",
        ANALYST_SHARED_SCHEMAS: "analytics",
      })
    ).toStrictEqual({
      schemas: ["billing", "analytics"],
      sharedSchemas: ["analytics"],
    });
    expect(
      resolveSchemaLists({
        ANALYST_SCHEMAS: "analytics,billing",
        ANALYST_SEED_DEMO_DATA: "true",
      })
    ).toStrictEqual({
      schemas: ["analytics", "billing"],
      sharedSchemas: ["analytics", "billing"],
    });
  });
});
