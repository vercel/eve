import { beforeEach, describe, expect, it, vi } from "vitest";

import { postgres } from "../analyst/postgres";
import type { AnalystQuery } from "../analyst/postgres";
import { fakePostgres } from "../testing/postgres";
import type { FakeResult } from "../testing/postgres";
import { isCallable, slackAuth, toolContext } from "../testing/session";
import tool, { describeSchemaInputSchema } from "./describe-schema";

const { execute } = tool;
if (!isCallable(execute)) {
  throw new Error("Expected an executable describe_schema tool.");
}

const describeSchema = async (tables?: string[]) => {
  const result = await execute(
    tables ? { tables } : {},
    toolContext({ current: slackAuth(), toolName: "describe_schema" })
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("Expected a single result.");
  }
  return result;
};

const install = (respond: (query: AnalystQuery) => FakeResult) => {
  vi.spyOn(postgres, "connect").mockImplementation(
    fakePostgres(respond).connect
  );
};

const plansOnly = (query: AnalystQuery): FakeResult =>
  query.text.includes("pg_attribute")
    ? {
        rows: [
          {
            column_comment: null,
            column_name: "plan_id",
            column_type: "text",
            name: "analytics.plans",
            not_null: true,
            table_comment: null,
          },
        ],
      }
    : {};

beforeEach(() => {
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv("ANALYST_TIMEZONE", "Australia/Sydney");
});

describe("describe_schema", () => {
  it("returns an overview with schemas and the reporting time zone", async () => {
    install((query) =>
      query.text.includes("pg_class") && !query.text.includes("pg_attribute")
        ? {
            rows: [
              {
                approx_rows: "5",
                comment: null,
                kind: "table",
                name: "analytics.plans",
              },
            ],
          }
        : {}
    );
    await expect(describeSchema()).resolves.toStrictEqual({
      schemas: ["analytics"],
      tables: [
        {
          approxRows: 5,
          comment: null,
          kind: "table",
          name: "analytics.plans",
        },
      ],
      timezone: "Australia/Sydney",
      truncated: false,
    });
  });

  it("explains an empty overview", async () => {
    install(() => ({}));
    await expect(describeSchema()).resolves.toMatchObject({
      note: expect.stringContaining("ANALYST_SCHEMAS"),
      tables: [],
    });
  });

  it("matches quoted and schema-qualified names without a missing note", async () => {
    install(plansOnly);
    const result = await describeSchema([
      '"plans"',
      '"analytics"."plans"',
      "Analytics.Plans",
    ]);
    expect(result).toMatchObject({ tables: [{ name: "analytics.plans" }] });
    expect(result).not.toHaveProperty("note");
  });

  it("notes names in schemas outside ANALYST_SCHEMAS as missing", async () => {
    install(plansOnly);
    await expect(describeSchema(["billing.invoices"])).resolves.toMatchObject({
      note: expect.stringContaining("billing.invoices"),
    });
  });

  it("describes named tables and notes missing ones", async () => {
    install((query) =>
      query.text.includes("pg_attribute")
        ? {
            rows: [
              {
                column_comment: null,
                column_name: "plan_id",
                column_type: "text",
                name: "analytics.plans",
                not_null: true,
                table_comment: null,
              },
            ],
          }
        : {}
    );
    await expect(describeSchema(["Plans", "nope"])).resolves.toStrictEqual({
      note: expect.stringContaining("No visible table named nope."),
      tables: [
        {
          columns: ["plan_id text not null"],
          comment: null,
          keys: [],
          name: "analytics.plans",
        },
      ],
    });
  });

  it("limits a call to 10 tables", () => {
    expect(
      describeSchemaInputSchema.safeParse({
        tables: Array.from({ length: 11 }, (_, index) => `t${index}`),
      }).success
    ).toBe(false);
  });
});
