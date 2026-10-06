import { describe, expect, it } from "vitest";

import { isAuthorizationSignal } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  type CatalogSkillSource,
  type FakeConnection,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

interface SearchOutput {
  readonly results: readonly Record<string, unknown>[];
  readonly total: number;
  readonly unavailable?: readonly Record<string, unknown>[];
}

/** The step's `search` tool, run inside its session. */
function searchFor(
  tools: readonly HarnessToolDefinition[],
  options: {
    readonly connections?: readonly FakeConnection[];
    readonly skills?: readonly CatalogSkillSource[];
  } = {},
) {
  const { catalog, run } = catalogContext({ ...options, tools });
  const search = catalog.advertised.get("search")!;
  return (input: Record<string, unknown>) =>
    run(async () => (await search.execute!(input, OPTIONS)) as SearchOutput);
}

const OPTIONS = { messages: [], toolCallId: "call-1" };

const names = (output: SearchOutput) => output.results.map((result) => result.tool ?? result.skill);

describe("search", () => {
  const tools = [
    inlineTool("add"),
    inlineTool("refund_invoice", {
      deferred: true,
      description: "Refund a paid invoice.",
      schema: {
        type: "object",
        properties: { invoiceId: { type: "string" } },
        required: ["invoiceId"],
      },
    }),
    inlineTool("list_invoices", { deferred: true, description: "List invoices to refund later." }),
    inlineTool("export_ledger", { deferred: true, description: "Export the ledger." }),
    subagentTool("billing_specialist", {
      deferred: true,
      description: "Resolve billing disputes and refunds.",
    }),
  ];
  const skills = [
    { deferred: true, description: "How to refund a disputed charge.", name: "refund-policy" },
    { description: "Refund wording for replies.", name: "refund-voice" },
  ];

  it("ranks tools and skills together by name before description", async () => {
    const output = await searchFor(tools, { skills })({ query: "refund" });

    expect(names(output)).toEqual([
      "refund_invoice",
      "refund-policy",
      "billing_specialist",
      "list_invoices",
    ]);
    expect(output.total).toBe(4);
    expect(output.results[1]).toEqual({
      description: "How to refund a disputed charge.",
      path: "$HOME/.agents/skills/refund-policy/SKILL.md",
      skill: "refund-policy",
    });
    expect(output.results[0]).toEqual({
      description: "Refund a paid invoice.",
      signature: "refund_invoice(input: { invoiceId: string }): Promise<unknown>",
      tool: "refund_invoice",
    });
  });

  it("finds only deferred entries; direct tools and listed skills are already in context", async () => {
    const output = await searchFor(tools, { skills })({});

    expect(names(output)).toEqual([
      "billing_specialist",
      "export_ledger",
      "list_invoices",
      "refund_invoice",
      "refund-policy",
    ]);
  });

  it("pages results and counts every match", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      inlineTool(`report_${String(index).padStart(2, "0")}`, { deferred: true }),
    );
    const search = searchFor(many);

    const page = await search({ limit: 2, offset: 3, query: "report" });
    expect(page).toEqual({
      results: [
        {
          description: "report_03 description",
          signature: "report_03(input: {}): Promise<unknown>",
          tool: "report_03",
        },
        {
          description: "report_04 description",
          signature: "report_04(input: {}): Promise<unknown>",
          tool: "report_04",
        },
      ],
      total: 60,
    });
    expect((await search({})).results).toHaveLength(10);
    expect((await search({ limit: 500 })).results).toHaveLength(50);
    expect((await search({ offset: 58 })).results.map((result) => result.tool)).toEqual([
      "report_58",
      "report_59",
    ]);
  });

  describe("connections", () => {
    const linear = () =>
      fakeConnection({
        description: "Linear issues and projects",
        name: "linear",
        tools: [
          connectionTool("list_issues", {
            type: "object",
            properties: { team: { type: "string" } },
            required: ["team"],
          }),
          connectionTool("create_project"),
        ],
      });

    it("ranks connection tools with local entries under their full names", async () => {
      const output = await searchFor(tools, { connections: [linear()] })({ query: "issues" });

      // The connection's description matches too, but weighs less than a tool's own name.
      expect(output.results).toEqual([
        {
          description: "list_issues description",
          signature: "linear__list_issues(input: { team: string }): Promise<unknown>",
          tool: "linear__list_issues",
        },
        {
          description: "create_project description",
          signature: "linear__create_project(input: Record<string, unknown>): Promise<unknown>",
          tool: "linear__create_project",
        },
      ]);
    });

    it("lists one connection's tools when searching it", async () => {
      const output = await searchFor(tools, { connections: [linear()] })({ connection: "linear" });

      expect(names(output)).toEqual(["linear__create_project", "linear__list_issues"]);
    });

    it("rejects a connection that is not available", async () => {
      await expect(
        searchFor(tools, { connections: [linear()] })({ connection: "jira" }),
      ).rejects.toThrow('Connection "jira" is not available. Available connections: linear.');
    });

    it("reports a connection that needs sign-in without prompting, and prompts only with signIn", async () => {
      const notion = fakeConnection({
        listing: "sign-in",
        name: "notion",
        signIn: true,
        tools: [connectionTool("search_pages")],
      });
      const search = searchFor(tools, { connections: [linear(), notion] });

      const plain = await search({ query: "pages" });
      expect(plain).toEqual({
        results: [],
        total: 0,
        unavailable: [
          {
            connection: "notion",
            error:
              'Sign-in required: the user has not signed in to "notion", so its tools cannot be listed. If the request needs "notion", call search with connection "notion" and signIn: true to ask the user to sign in.',
            requiresSignIn: true,
          },
        ],
      });
      expect(await search({ connection: "notion" })).toMatchObject({
        unavailable: [{ connection: "notion", requiresSignIn: true }],
      });
      expect(notion.signIns).toEqual([]);

      await expect(search({ signIn: true })).rejects.toThrow(
        "search with signIn: true requires `connection`.",
      );
      const signIn = await search({ connection: "notion", signIn: true });
      expect(isAuthorizationSignal(signIn)).toBe(true);
      expect(notion.signIns).toHaveLength(1);
    });

    it("reports a connection that cannot start sign-in as unavailable, without requiresSignIn", async () => {
      const vault = fakeConnection({ listing: "sign-in", name: "vault", tools: [] });
      const search = searchFor(tools, { connections: [vault] });

      expect((await search({})).unavailable).toEqual([
        {
          connection: "vault",
          error: '"vault" requires authorization and cannot start interactive sign-in.',
        },
      ]);
      await expect(search({ connection: "vault", signIn: true })).rejects.toThrow(
        '"vault" requires authorization and cannot start interactive sign-in.',
      );
    });

    it("lists a connection whose tools fail to load for another reason, and fails a search of it alone", async () => {
      const logs = captureLogRecords();
      const broken = fakeConnection({
        listing: new Error("upstream returned 502"),
        name: "crm",
        tools: [],
      });
      const search = searchFor(tools, { connections: [linear(), broken] });

      const output = await search({});
      expect(names(output)).toContain("linear__list_issues");
      expect(output.unavailable).toEqual([
        { connection: "crm", error: 'Failed to load tools for "crm": upstream returned 502' },
      ]);
      await expect(search({ connection: "crm" })).rejects.toThrow(
        'Failed to load tools for "crm": upstream returned 502',
      );
      expect(logs.records).toContainEqual(
        expect.objectContaining({ level: "warn", message: "failed to load connection tools" }),
      );
    });
  });
});
