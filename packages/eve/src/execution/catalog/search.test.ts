import { describe, expect, it } from "vitest";

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

    // Equal matches sort by name, compared by code unit: `-` before `_`.
    expect(names(output)).toEqual([
      "refund-policy",
      "refund_invoice",
      "billing_specialist",
      "list_invoices",
    ]);
    expect(output.total).toBe(4);
    expect(output.results[0]).toEqual({
      description: "How to refund a disputed charge.",
      path: "$HOME/.agents/skills/refund-policy/SKILL.md",
      skill: "refund-policy",
    });
    expect(output.results[1]).toEqual({
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
      "refund-policy",
      "refund_invoice",
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

    it("lists a connection whose tools need sign-in as one result named after it, and never prompts", async () => {
      const notion = fakeConnection({
        description: "Notion pages and databases",
        listing: "sign-in",
        name: "notion",
        signIn: true,
        tools: [connectionTool("search_pages")],
      });
      const search = searchFor(tools, { connections: [linear(), notion] });

      const signIn = {
        description: "Sign in to use the Notion tools: Notion pages and databases",
        signature: "notion(input: {}): Promise<unknown>",
        tool: "notion",
      };
      expect(await search({ query: "notion" })).toEqual({ results: [signIn], total: 1 });
      // Found by the connection's description too, while its tools can't be listed.
      expect((await search({ query: "pages" })).results).toEqual([signIn]);
      expect(names(await search({}))).toEqual(
        expect.arrayContaining(["notion", "linear__list_issues"]),
      );
      expect(notion.signIns).toEqual([]);
    });

    it("reports a connection that cannot start sign-in, and one whose tools fail to load, as unavailable", async () => {
      const logs = captureLogRecords();
      const vault = fakeConnection({ listing: "sign-in", name: "vault", tools: [] });
      const crm = fakeConnection({
        listing: new Error("upstream returned 502"),
        name: "crm",
        tools: [],
      });

      const output = await searchFor(tools, { connections: [linear(), vault, crm] })({});

      expect(names(output)).toContain("linear__list_issues");
      expect(names(output)).not.toContain("vault");
      expect(output.unavailable).toEqual([
        {
          connection: "vault",
          error: '"vault" requires authorization and cannot start interactive sign-in.',
        },
        { connection: "crm", error: 'Failed to load tools for "crm": upstream returned 502' },
      ]);
      expect(logs.records).toContainEqual(
        expect.objectContaining({ level: "warn", message: "failed to load connection tools" }),
      );
    });
  });

  describe("ranking", () => {
    const search = searchFor(
      [
        inlineTool("pdf", { deferred: true, description: "Open a document." }),
        inlineTool("pdf_fill", {
          deferred: true,
          description: "Fill a PDF form from pdf fields.",
          schema: {
            type: "object",
            properties: { pdf: { type: "string", description: "The pdf to fill." } },
          },
        }),
        inlineTool("create_issue", { deferred: true, description: "File a local ticket." }),
        inlineTool("linear_report", { deferred: true, description: "Summarize Linear usage." }),
      ],
      {
        connections: [
          fakeConnection({
            description: "Linear issues and projects",
            name: "linear",
            tools: [
              connectionTool("create_issue"),
              connectionTool("create_project"),
              connectionTool("list_issues"),
            ],
          }),
          fakeConnection({
            description: "Jira issues",
            name: "jira",
            tools: [connectionTool("create_issue")],
          }),
          fakeConnection({
            description: "Service health",
            name: "ops",
            tools: [connectionTool("getHTTPServerStatus")],
          }),
          fakeConnection({ description: "Posts", name: "x", tools: [connectionTool("post")] }),
        ],
        skills: [{ deferred: true, description: "Fill PDF forms.", name: "pdf-forms" }],
      },
    );
    const ranked = async (query: string) => names(await search({ limit: 50, query }));

    it("ranks an exact name first, above an entry that mentions it in more places", async () => {
      expect((await ranked("pdf")).slice(0, 2)).toEqual(["pdf", "pdf_fill"]);
    });

    it("ranks an exact full name above the same name under a connection's prefix", async () => {
      const results = await ranked("create_issue");

      expect(results[0]).toBe("create_issue");
      expect(results.slice(1, 3).sort()).toEqual(["jira__create_issue", "linear__create_issue"]);
      expect((await ranked("linear__create_issue"))[0]).toBe("linear__create_issue");
    });

    it("lists a connection's tools for its name, before an entry whose name starts with it", async () => {
      const results = await ranked("linear");

      expect(results.slice(0, 3).sort()).toEqual([
        "linear__create_issue",
        "linear__create_project",
        "linear__list_issues",
      ]);
      expect(results[3]).toBe("linear_report");
    });

    it("matches a name prefix whose last word is partial", async () => {
      expect((await ranked("create_iss")).slice(0, 3).sort()).toEqual([
        "create_issue",
        "jira__create_issue",
        "linear__create_issue",
      ]);
      expect((await ranked("linear__cre")).slice(0, 2).sort()).toEqual([
        "linear__create_issue",
        "linear__create_project",
      ]);
    });

    it("finds a one-letter connection by its name", async () => {
      expect((await ranked("x"))[0]).toBe("x__post");
    });

    it.each(["http server", "getHttpServer", "get_http_server_status"])(
      "splits camelCase and acronyms into words, so %s finds getHTTPServerStatus",
      async (query) => {
        expect((await ranked(query))[0]).toBe("ops__getHTTPServerStatus");
      },
    );

    it("lists every entry for an empty query, by connection and then name in code-unit order", async () => {
      expect(await ranked("")).toEqual([
        "create_issue",
        "linear_report",
        "pdf",
        "pdf-forms",
        "pdf_fill",
        "jira__create_issue",
        "linear__create_issue",
        "linear__create_project",
        "linear__list_issues",
        "ops__getHTTPServerStatus",
        "x__post",
      ]);
    });
  });
});
