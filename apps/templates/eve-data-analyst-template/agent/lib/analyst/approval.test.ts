import { beforeEach, describe, expect, it, vi } from "vitest";

import { explainResult, fakePostgres } from "../testing/postgres";
import type { FakeResult } from "../testing/postgres";
import {
  approvalContext,
  approvalResponseContext,
  localDevAuth,
  slackAuth,
  slackBotAuth,
  webAuth,
} from "../testing/session";
import { installTestState, testState } from "../testing/state";
import { requestRunSqlApproval, respondToRunSqlApproval } from "./approval";
import type { AnalystQuery } from "./postgres";
import { postgres } from "./postgres";

const input = {
  purpose: "MRR last month",
  sql: "SELECT sum(mrr_cents) FROM subscriptions",
};

const planning = (respond: (query: AnalystQuery) => FakeResult) => {
  const fake = fakePostgres((query) =>
    query.text.startsWith("EXPLAIN") ? respond(query) : {}
  );
  vi.spyOn(postgres, "connect").mockImplementation(fake.connect);
  return fake;
};

const request = (
  options: Parameters<typeof approvalContext>[1] = {},
  toolInput: typeof input = input
) =>
  requestRunSqlApproval(
    approvalContext(toolInput, { toolName: "run_sql", ...options })
  );

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv("ANALYST_APPROVAL_COST", "1000");
});

describe(requestRunSqlApproval, () => {
  it("lets cheap queries run without approval", async () => {
    planning(() => explainResult(999));
    await expect(request()).resolves.toBe("not-applicable");
  });

  it("asks the person for approval above the threshold and records the estimate", async () => {
    planning(() => explainResult(2500));
    await expect(request()).resolves.toBe("user-approval");
    expect(testState.get("analyst.query-estimates")).toStrictEqual({
      "call-1": {
        askerSlackUserId: "U123",
        planRows: 10,
        sql: input.sql,
        threshold: 1000,
        totalCost: 2500,
      },
    });
  });

  it("records no Slack user for local development", async () => {
    planning(() => explainResult(2500));
    await expect(request({ current: localDevAuth() })).resolves.toBe(
      "user-approval"
    );
    expect(testState.get("analyst.query-estimates")).toMatchObject({
      "call-1": { askerSlackUserId: null },
    });
  });

  it("explains missing setup instead of failing the turn", async () => {
    vi.stubEnv("ANALYST_DATABASE_URL", "");
    await expect(request()).resolves.toMatchObject({
      reason: expect.stringContaining("isn't configured yet"),
      type: "denied",
    });
  });

  it("denies callers without warehouse access before planning", async () => {
    const { queries } = planning(() => explainResult(1));
    await expect(request({ current: slackBotAuth() })).resolves.toMatchObject({
      reason: expect.stringContaining("Bots"),
      type: "denied",
    });
    expect(queries).toHaveLength(0);
  });

  it("tells mapped service callers to narrow expensive queries", async () => {
    vi.stubEnv(
      "ANALYST_ROLE_MAP",
      JSON.stringify({ "slack:T123:bot:B123": "analyst_reports" })
    );
    planning(() => explainResult(2500));
    await expect(request({ current: slackBotAuth() })).resolves.toMatchObject({
      reason: expect.stringContaining("Narrow it"),
      type: "denied",
    });
  });

  it("denies a plan that calls a forbidden function", async () => {
    planning(() =>
      explainResult(1, {
        Output: ["set_config('role'::text, 'x'::text, true)"],
      })
    );
    await expect(request()).resolves.toStrictEqual({
      reason: "Queries can't call set_config().",
      type: "denied",
    });
  });

  it("denies a plan that calls ts_stat()", async () => {
    planning(() =>
      explainResult(1, {
        Plans: [
          {
            "Function Call": "ts_stat(concat('sel'::text, 'ect 1'::text))",
            "Node Type": "Function Scan",
          },
        ],
      })
    );
    await expect(request()).resolves.toStrictEqual({
      reason: "Queries can't call ts_stat().",
      type: "denied",
    });
  });

  it("fails closed with the Postgres message when planning fails", async () => {
    planning(() => {
      throw Object.assign(
        new Error('relation "subscriptionz" does not exist'),
        { code: "42P01" }
      );
    });
    await expect(request()).resolves.toStrictEqual({
      reason:
        'Postgres rejected this query while planning it: relation "subscriptionz" does not exist. If it names a table or column the person can\'t access, tell them. Otherwise fix the SQL and try again.',
      type: "denied",
    });
  });

  it("tells the model to stop when it can't connect", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => null);
    vi.spyOn(postgres, "connect").mockRejectedValue(
      new Error("password authentication failed for user")
    );
    const decision = await request();
    expect(decision).toStrictEqual({
      reason:
        "The warehouse is unavailable: couldn't connect to the database. An admin can run `pnpm db:doctor` to see why, or check the setup lines in the latest deploy log. Tell the person and stop, because changing the query won't help.",
      type: "denied",
    });
  });

  it("tells the model to stop when the session can't switch to the role", async () => {
    const fake = fakePostgres((query) => {
      if (query.text.startsWith("BEGIN")) {
        throw Object.assign(
          new Error('permission denied to set role "analyst_readonly"'),
          { code: "42501" }
        );
      }
      return {};
    });
    vi.spyOn(postgres, "connect").mockImplementation(fake.connect);
    const decision = await request();
    expect(decision).toMatchObject({
      reason: expect.stringMatching(
        /^The warehouse is unavailable: couldn't start a read-only session as your database role \(permission denied to set role "analyst_readonly"\)\..* Tell the person and stop/u
      ),
      type: "denied",
    });
    expect(decision).not.toMatchObject({
      reason: expect.stringContaining("fix the SQL"),
    });
  });

  it("tells the model to stop when the server shuts down while planning", async () => {
    planning(() => {
      throw Object.assign(
        new Error("terminating connection due to administrator command"),
        { code: "57P01" }
      );
    });
    await expect(request()).resolves.toStrictEqual({
      reason:
        "The warehouse is unavailable: terminating connection due to administrator command. Tell the person and stop, because changing the query won't help.",
      type: "denied",
    });
  });

  it("asks the model to report a missing grant rather than only rewrite", async () => {
    planning(() => {
      throw Object.assign(new Error("permission denied for table invoices"), {
        code: "42501",
      });
    });
    await expect(request()).resolves.toMatchObject({
      reason: expect.stringContaining(
        "permission denied for table invoices. If it names a table or column the person can't access, tell them."
      ),
      type: "denied",
    });
  });
});

const respond = (
  options: Pick<
    NonNullable<Parameters<typeof approvalResponseContext>[0]>,
    "decision" | "requester" | "responder"
  >
) =>
  Promise.resolve(
    respondToRunSqlApproval(
      approvalResponseContext({
        toolInput: input,
        toolName: "run_sql",
        ...options,
      })
    )
  );

describe(respondToRunSqlApproval, () => {
  it.each(["approve", "cancel"] as const)(
    "lets the asker %s",
    async (decision) => {
      await expect(respond({ decision })).resolves.toStrictEqual({
        status: "allowed",
      });
    }
  );

  it("lets local development answer its own requests", async () => {
    await expect(
      respond({ requester: localDevAuth(), responder: localDevAuth() })
    ).resolves.toStrictEqual({ status: "allowed" });
  });

  it.each([
    ["another Slack user", slackAuth(), slackAuth({ userId: "U999" })],
    [
      "the same user ID from another workspace",
      slackAuth(),
      slackAuth({ teamId: "T999" }),
    ],
    [
      "a different authenticator",
      slackAuth(),
      { ...slackAuth(), authenticator: "web-session" },
    ],
    ["a bot", slackBotAuth(), slackBotAuth()],
    ["an anonymous request", null, webAuth()],
  ])("rejects %s", async (_name, requester, responder) => {
    await expect(respond({ requester, responder })).resolves.toMatchObject({
      reason: expect.stringContaining("Only the person who asked"),
      status: "rejected",
    });
  });
});
