import { describe, expect, it, vi } from "vitest";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
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
  const search = catalog.advertised.get(SEARCH_TOOL_NAME)!;
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

  it("labels a search with its query, then with how much it found", async () => {
    const { catalog, run } = catalogContext({ skills, tools });
    const search = catalog.advertised.get(SEARCH_TOOL_NAME)!;
    const label = search.label!;
    const found = await run(() => search.execute!({ query: "refund" }, OPTIONS));

    expect(label.start!({ query: "refund" })).toBe("Search tools for “refund”");
    expect(label.complete!({ query: "refund" }, found)).toBe(
      "Searched tools for “refund”, found 4",
    );
    expect(label.complete!({ query: "zebra" }, { results: [] })).toBe(
      "Searched tools for “zebra”, found nothing",
    );
    const unavailable = (count: number) => ({
      results: [],
      unavailable: Array.from({ length: count }, (_, i) => ({
        connection: `c${i}`,
        error: "down",
      })),
    });
    expect(label.complete!({ query: "zebra" }, unavailable(1))).toBe(
      "Searched tools for “zebra”, found nothing; 1 connection unavailable",
    );
    expect(label.complete!({ query: "zebra" }, unavailable(2))).toBe(
      "Searched tools for “zebra”, found nothing; 2 connections unavailable",
    );
  });

  it("finds only deferred entries; direct tools and listed skills are already in context", async () => {
    const search = searchFor(tools, { skills });

    expect(await search({ query: "add" })).toEqual({ results: [] });
    expect(names(await search({ query: "refund voice" }))).not.toContain("refund-voice");
  });

  it("requires a query with at least one word", async () => {
    const search = searchFor(tools, { skills });
    const schema = catalogContext({ tools }).catalog.advertised.get(SEARCH_TOOL_NAME)!
      .inputSchema as StandardSchemaV1;
    const needsWords =
      'search needs at least one word in query, such as a capability ("list open issues") or a name or connection prefix ("linear__").';

    expect(await schema["~standard"].validate({ limit: 5 })).toEqual({
      issues: [
        expect.objectContaining({ message: 'Instance does not have required property "query".' }),
      ],
    });
    await expect(search({ query: "  ^ " })).rejects.toThrow(needsWords);
    await expect(search({})).rejects.toThrow(needsWords);
  });

  it("returns the best matches up to limit, 20 by default, and takes no paging", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      inlineTool(`report_${String(index).padStart(2, "0")}`, { deferred: true }),
    );
    const search = searchFor(many);

    const best = names(await search({ limit: 50, query: "report" }));
    expect(best).toHaveLength(50);
    // A smaller limit keeps the best matches, in rank order.
    expect(names(await search({ limit: 3, query: "report" }))).toEqual(best.slice(0, 3));
    expect(names(await search({ query: "report" }))).toEqual(best.slice(0, 20));

    // The model's calls are checked against the schema, which caps limit at 50 and has no offset.
    const schema = catalogContext({ tools: many }).catalog.advertised.get(SEARCH_TOOL_NAME)!
      .inputSchema as StandardSchemaV1;
    expect(await schema["~standard"].validate({ limit: 51, query: "report" })).toEqual({
      issues: [expect.objectContaining({ path: ["limit"] })],
    });
    expect(await schema["~standard"].validate({ offset: 10, query: "report" })).toEqual({
      issues: [expect.objectContaining({ message: 'Unrecognized key: "offset"' })],
    });
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
      expect(await search({ query: "notion" })).toEqual({ results: [signIn] });
      // Found by the connection's description too, while its tools can't be listed.
      expect((await search({ query: "pages" })).results).toEqual([signIn]);
      expect(names(await search({ query: "notion__" }))).toEqual(["notion"]);
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

      const output = await searchFor(tools, { connections: [linear(), vault, crm] })({
        query: "issues",
      });

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

    it("lists a connection's tools first only for its whole name, not a partial one", async () => {
      const search = searchFor([inlineTool("git_status", { deferred: true })], {
        connections: [
          fakeConnection({
            name: "github",
            tools: [connectionTool("create_issue"), connectionTool("list_pulls")],
          }),
        ],
      });
      const ranked = async (query: string) => names(await search({ query }));

      expect(await ranked("git")).toEqual([
        "git_status",
        "github__create_issue",
        "github__list_pulls",
      ]);
      expect((await ranked("github")).slice(0, 2)).toEqual([
        "github__create_issue",
        "github__list_pulls",
      ]);
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

    it("matches the name after any namespace, not only a connection's, as exact or prefix", async () => {
      const search = searchFor([
        inlineTool("sre__status_page_incidents_list", {
          deferred: true,
          description: "List open incidents.",
        }),
        inlineTool("sre__status_page_incident_get", {
          deferred: true,
          description: "Get one status page incident, with its status, page, and incidents linked.",
        }),
        inlineTool("support__refund", { deferred: true, description: "Refund an order." }),
        inlineTool("refund_policy", { deferred: true, description: "Read the refund policy." }),
      ]);
      const ranked = async (query: string) => names(await search({ query }));

      expect((await ranked("status page incidents"))[0]).toBe("sre__status_page_incidents_list");
      expect((await ranked("refund"))[0]).toBe("support__refund");
    });

    it("keeps a name without a namespace whole for exact and prefix matches", async () => {
      const search = searchFor([
        inlineTool("xrefund", { deferred: true, description: "Refund a charge." }),
        inlineTool("refund_policy", { deferred: true, description: "Read the policy." }),
      ]);
      const ranked = async (query: string) => names(await search({ query }));

      expect(await ranked("refund")).toEqual(["refund_policy", "xrefund"]);
      expect((await ranked("xrefund"))[0]).toBe("xrefund");
      expect((await ranked("refund_pol"))[0]).toBe("refund_policy");
    });

    it("leaves one-letter and filler words out of scoring unless the query has nothing else", async () => {
      const search = searchFor([
        inlineTool("support__case_assign", {
          deferred: true,
          description: "Assign a support case to a teammate.",
        }),
        inlineTool("support__case_reply_draft", {
          deferred: true,
          description: "Write a response.",
        }),
      ]);
      const ranked = async (query: string) => names(await search({ query }));

      expect((await ranked("draft a reply to a support ticket"))[0]).toBe(
        "support__case_reply_draft",
      );
      expect(await ranked("a")).toContain("support__case_assign");
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

    it("lists a bare namespace by name, in a fixed order", async () => {
      expect(await ranked("linear__")).toEqual([
        "linear__create_issue",
        "linear__create_project",
        "linear__list_issues",
      ]);
    });
  });

  describe("namespace queries", () => {
    function namespaced() {
      const crmApi = fakeConnection({
        description: "CRM customers and deals",
        name: "crm__api",
        tools: [
          connectionTool("get_customer"),
          connectionTool("list_customers"),
          connectionTool("list_deals"),
        ],
      });
      const notion = fakeConnection({
        listing: "sign-in",
        name: "notion",
        signIn: true,
        tools: [connectionTool("search_pages")],
      });
      const linear = fakeConnection({
        name: "linear",
        tools: [
          connectionTool("list_issues"),
          connectionTool("issue__create"),
          connectionTool("issue__create_comment"),
        ],
      });
      const broken = fakeConnection({
        listing: new Error("upstream returned 502"),
        name: "jira",
        tools: [],
      });
      const empty = fakeConnection({ name: "archive", tools: [] });
      const outside = [linear, broken].map((connection) =>
        vi.spyOn(connection.client, "getToolMetadata"),
      );
      const search = searchFor(
        [
          // An extension mounted as `crm` adds a tool and a connection under its name.
          inlineTool("crm__export", { deferred: true, description: "Export CRM accounts." }),
          inlineTool("export_ledger", {
            deferred: true,
            description: "Export the ledger to the crm.",
          }),
        ],
        { connections: [crmApi, notion, linear, broken, empty] },
      );
      return { notion, outside, search };
    }

    it("keeps only the namespace, including a connection mounted under it, and never lists other connections", async () => {
      const { outside, search } = namespaced();

      const output = await search({ query: "crm__" });

      expect(names(output).sort()).toEqual([
        "crm__api__get_customer",
        "crm__api__list_customers",
        "crm__api__list_deals",
        "crm__export",
      ]);
      // Connections that can't own the namespace aren't asked for their tools, so the
      // failing one isn't reported either.
      expect(output.unavailable).toBeUndefined();
      for (const getToolMetadata of outside) expect(getToolMetadata).not.toHaveBeenCalled();
    });

    it("ranks the namespace by the whole query, best match first", async () => {
      const { search } = namespaced();

      const found = names(await search({ query: "crm__api__list deals" }));

      expect(found[0]).toBe("crm__api__list_deals");
      expect(found.every((name) => String(name).startsWith("crm__api__"))).toBe(true);
    });

    it("ranks a tool whose own name contains __ first for its exact full name", async () => {
      const { search } = namespaced();

      expect(names(await search({ query: "linear__issue__create" }))[0]).toBe(
        "linear__issue__create",
      );
    });

    it("keeps a connection's sign-in entry, alone or with words after the namespace, without prompting", async () => {
      const { notion, search } = namespaced();

      expect(names(await search({ query: "notion__" }))).toEqual(["notion"]);
      expect(names(await search({ query: "notion__search pages" }))).toEqual(["notion"]);
      expect(notion.signIns).toEqual([]);
    });

    it("ignores a leading ^ and trailing underscores", async () => {
      const { search } = namespaced();
      const linear = await search({ query: "linear__" });

      expect(await search({ query: "^linear__" })).toEqual(linear);
      expect(await search({ query: "linear____" })).toEqual(linear);
    });

    it.each([
      ["Linear__", 'No entries are named "Linear__…". Closest connections: linear.'],
      [
        "nope__x",
        'No entries are named "nope__…". Find names in the catalog listing or your tool list, or call eve__search with plain words.',
      ],
      ["archive__", 'Connection "archive" has no tools.'],
    ])("fails for %s, a namespace with no entries", async (query, message) => {
      const { outside, search } = namespaced();

      await expect(search({ query })).rejects.toThrow(message);
      if (query === "nope__x") {
        for (const getToolMetadata of outside) expect(getToolMetadata).not.toHaveBeenCalled();
      }
    });
  });
});
