import { describe, expect, it } from "vitest";
import { EXECUTE_TOOL_NAME, SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { isAuthorizationSignal, PendingAuthorizationResultKey } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { ContextContainer } from "#context/container.js";
import {
  catalogBundle,
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  toolMap,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

import { buildStepCatalog, type StepCatalog } from "./step-catalog.js";

const CHILD = { rootSessionId: "root-session" };

const names = (tools: ReadonlyMap<string, HarnessToolDefinition>) => [...tools.keys()];

/** Validates `input` against the `execute` schema, which every call passes before it runs. */
function validateExecute(catalog: StepCatalog, input: unknown) {
  const schema = catalog.advertised.get(EXECUTE_TOOL_NAME)!.inputSchema as StandardSchemaV1;
  return schema["~standard"].validate(input);
}

describe("buildStepCatalog", () => {
  it("lists direct entries, then search and execute, and keeps deferred entries out of the tool list", () => {
    const { catalog } = catalogContext({
      tools: [inlineTool("add"), inlineTool("refund_invoice", { deferred: true })],
    });

    expect(names(catalog.advertised)).toEqual(["add", SEARCH_TOOL_NAME, EXECUTE_TOOL_NAME]);
    expect(names(catalog.deferred)).toEqual(["refund_invoice"]);
  });

  describe("which catalog tools the agent gets", () => {
    /** The tool list of an agent that declares one dynamic resolver of `kind`. */
    function advertisedWithResolver(
      kind: "dynamicConnectionResolvers" | "dynamicSkillResolvers" | "dynamicToolResolvers",
    ) {
      const bundle = catalogBundle();
      const ctx = new ContextContainer();
      ctx.set(BundleKey, { ...bundle, resolvedAgent: { ...bundle.resolvedAgent, [kind]: [{}] } });
      return names(
        buildStepCatalog({ agentTools: toolMap(), ctx, endsTurn: true, session: {} }).advertised,
      );
    }

    it("gives an agent with nothing to find or load neither tool", () => {
      const { catalog } = catalogContext({ tools: [inlineTool("add")] });

      expect(names(catalog.advertised)).toEqual(["add"]);
    });

    it("gives an agent with only listed skills an execute that loads them and never mentions search", async () => {
      const { catalog } = catalogContext({ skills: [{ name: "house-rules" }] });
      const execute = catalog.advertised.get(EXECUTE_TOOL_NAME)!;

      expect(names(catalog.advertised)).toEqual([EXECUTE_TOOL_NAME]);
      expect(execute.description).toBe(
        "Load one of your listed skills by name with `skill`, then follow the instructions it returns.",
      );
      expect(await validateExecute(catalog, { skill: "house-rules" })).toEqual({
        value: { skill: "house-rules" },
      });
      const unknown = JSON.stringify(await validateExecute(catalog, { skill: "house_rules" }));
      expect(unknown).toContain('No skill named \\"house_rules\\"');
      expect(unknown).not.toContain(SEARCH_TOOL_NAME);
    });

    it.each([
      ["a deferred tool", { tools: [inlineTool("refund_invoice", { deferred: true })] }],
      ["a deferred agent", { tools: [subagentTool("researcher", { deferred: true })] }],
      ["a deferred skill", { skills: [{ deferred: true, name: "pdf-forms" }] }],
      ["a connection", { connections: [fakeConnection({ name: "linear", tools: [] })] }],
      ["a dynamic subagent resolver", { dynamicSubagents: ["helper"] }],
    ])("gives an agent with %s both tools", (_, declared) => {
      // A subagent also brings the task tools; the catalog tools come last.
      expect(names(catalogContext(declared).catalog.advertised).slice(-2)).toEqual([
        SEARCH_TOOL_NAME,
        EXECUTE_TOOL_NAME,
      ]);
    });

    it.each([
      "dynamicToolResolvers",
      "dynamicSkillResolvers",
      "dynamicConnectionResolvers",
    ] as const)("gives an agent with %s both tools, whatever they resolve", (kind) => {
      expect(advertisedWithResolver(kind)).toEqual([SEARCH_TOOL_NAME, EXECUTE_TOOL_NAME]);
    });
  });

  it("hides root-only entries, direct or deferred, from delegated sessions", async () => {
    const tools = [
      inlineTool("add"),
      inlineTool("notify_team", { availableInSubagents: false }),
      inlineTool("billing", { behavior: { availability: ["root-session"] } }),
      inlineTool("archive", { availableInSubagents: false, deferred: true }),
      subagentTool("agent", { rootOnly: true }),
      subagentTool("delegate"),
      subagentTool("researcher", { deferred: true }),
    ];

    const root = catalogContext({ tools }).catalog;
    expect(names(root.advertised)).toEqual([
      "add",
      "notify_team",
      "billing",
      "agent",
      "delegate",
      TASK_WAIT_TOOL_NAME,
      TASK_CANCEL_TOOL_NAME,
      SEARCH_TOOL_NAME,
      EXECUTE_TOOL_NAME,
    ]);
    expect(names(root.deferred)).toEqual(["archive", "researcher"]);

    const child = catalogContext({ session: CHILD, tools }).catalog;
    expect(names(child.advertised)).toEqual([
      "add",
      "delegate",
      TASK_WAIT_TOOL_NAME,
      TASK_CANCEL_TOOL_NAME,
      SEARCH_TOOL_NAME,
      EXECUTE_TOOL_NAME,
    ]);
    expect(names(child.deferred)).toEqual(["researcher"]);
    // A hidden entry can't be reached through execute either.
    expect(await validateExecute(child, { tool: "archive" })).toEqual({
      issues: [
        { message: 'No tool named "archive". Find tools with eve__search.', path: ["tool"] },
      ],
    });
  });

  describe("task tools", () => {
    const offered = (catalog: StepCatalog) => ({
      advertised:
        catalog.advertised.has(TASK_WAIT_TOOL_NAME) &&
        catalog.advertised.has(TASK_CANCEL_TOOL_NAME),
      offersTasks: catalog.offersTasks,
    });
    const offeredFor = (...input: Parameters<typeof catalogContext>) =>
      offered(catalogContext(...input).catalog);
    const OFFERED = { advertised: true, offersTasks: true };
    const NOT_OFFERED = { advertised: false, offersTasks: false };

    it("are offered while a tool the session sees starts tasks, deferred or not", () => {
      expect(offeredFor({ tools: [inlineTool("add")] })).toEqual(NOT_OFFERED);
      expect(offeredFor({ tools: [workflowTool("deploy_service")] })).toEqual(NOT_OFFERED);
      expect(offeredFor({ tools: [workflowTool("research", "task", { deferred: true })] })).toEqual(
        OFFERED,
      );
      expect(offeredFor({ tools: [subagentTool("delegate")] })).toEqual(OFFERED);
    });

    it("are not offered to a leaf subagent session whose only task-starting tool is root-only", () => {
      const tools = [inlineTool("add"), subagentTool("agent", { rootOnly: true })];

      expect(offeredFor({ tools })).toEqual(OFFERED);
      expect(offeredFor({ session: CHILD, tools })).toEqual(NOT_OFFERED);
    });

    it("are offered when the agent resolves subagents at runtime", () => {
      expect(offeredFor({ dynamicSubagents: ["specialist"], tools: [inlineTool("add")] })).toEqual(
        OFFERED,
      );
    });
  });

  describe("resolve", () => {
    const refundInvoice = inlineTool("refund_invoice", { deferred: true });
    const add = inlineTool("add");
    const { catalog } = catalogContext({
      skills: [{ name: "pdf-forms", deferred: true, markdown: "# PDF forms" }],
      tools: [add, refundInvoice, subagentTool("billing_specialist", { deferred: true })],
    });

    it("resolves a call through execute to the entry it names, keeping the model's call id", () => {
      const call = {
        input: { input: { invoiceId: "in_1" }, tool: "refund_invoice" },
        toolCallId: "call-1",
        toolName: EXECUTE_TOOL_NAME,
      };

      expect(catalog.resolve(call)).toEqual({
        call: { input: { invoiceId: "in_1" }, toolCallId: "call-1", toolName: "refund_invoice" },
        definition: refundInvoice,
      });
      expect(
        catalog.resolve({ input: { tool: "billing_specialist" }, toolName: EXECUTE_TOOL_NAME })
          ?.call,
      ).toEqual({ input: {}, toolName: "billing_specialist" });
    });

    it("resolves execute({ skill }) to the skill loader, which returns the skill's markdown", async () => {
      const resolved = catalog.resolve({
        input: { skill: "pdf-forms" },
        toolName: EXECUTE_TOOL_NAME,
      });

      expect(resolved?.call).toEqual({ input: { skill: "pdf-forms" }, toolName: "eve:load-skill" });
      const label = resolved?.definition.label;
      expect(label?.start?.(resolved?.call.input)).toBe("Load skill pdf-forms");
      expect(label?.complete?.(resolved?.call.input, "# PDF forms")).toBe("Loaded skill pdf-forms");
      expect(
        await resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "" }),
      ).toBe("# PDF forms");
    });

    it("resolves a direct call only to a listed tool", () => {
      expect(catalog.resolve({ input: {}, toolName: "add" })?.definition).toBe(add);
      expect(catalog.resolve({ input: {}, toolName: "refund_invoice" })).toBeUndefined();
      expect(
        catalog.resolve({ input: { tool: "add" }, toolName: EXECUTE_TOOL_NAME }),
      ).toBeUndefined();
    });
  });

  describe("execute validation", () => {
    const { catalog } = catalogContext({
      connections: [fakeConnection({ name: "linear", tools: [] })],
      skills: [
        { name: "release_notes", deferred: true },
        { name: "release-checklist" },
        { name: "refund_invoice", deferred: true },
      ],
      tools: [
        inlineTool("add"),
        inlineTool("refund_invoice", {
          deferred: true,
          schema: {
            type: "object",
            properties: { invoiceId: { type: "string" } },
            required: ["invoiceId"],
            additionalProperties: false,
          },
        }),
        inlineTool("refund_payment", { deferred: true }),
        inlineTool("stripe_list_disputes", { deferred: true }),
      ],
    });

    it.each([
      [
        "an unknown tool, with the closest names",
        { tool: "refund_invoce" },
        "tool",
        'No tool named "refund_invoce". Closest tools: refund_invoice, refund_payment.',
      ],
      [
        "an unknown tool with no close names",
        { tool: "weather" },
        "tool",
        'No tool named "weather". Find tools with eve__search.',
      ],
      [
        "a tool in the model's tool list",
        { tool: "add" },
        "tool",
        '"add" is in your tool list; call it directly.',
      ],
      [
        "eve__execute itself",
        { tool: EXECUTE_TOOL_NAME },
        "tool",
        `"${EXECUTE_TOOL_NAME}" is in your tool list; call it directly.`,
      ],
      [
        "a skill named as a tool when no tool has its name",
        { tool: "release_notes" },
        "tool",
        '"release_notes" is a skill; load it with eve__execute({ skill: "release_notes" }).',
      ],
      [
        "an unknown skill, with the closest names",
        { skill: "release" },
        "skill",
        'No skill named "release". Closest skills: release-checklist, release_notes.',
      ],
      [
        "a skill named like a connection",
        { skill: "Linear" },
        "skill",
        'No skill named "Linear". Find skills with eve__search. "linear" is a connection, not a skill. Find its tools with eve__search({ query: "linear__" }).',
      ],
      ["neither tool nor skill", {}, "tool", "Pass `tool`, or `skill` to load a skill."],
      [
        "both tool and skill",
        { skill: "release_notes", tool: "refund_payment" },
        "skill",
        "Pass either `tool` or `skill`, not both.",
      ],
      [
        "input with a skill",
        { input: { page: 2 }, skill: "release_notes" },
        "input",
        "A skill takes no `input`; pass `input` only with `tool`.",
      ],
    ])("rejects %s", async (_case, input, path, message) => {
      expect(await validateExecute(catalog, input)).toEqual({
        issues: [{ message, path: [path] }],
      });
    });

    it("accepts an empty input with a skill, since input defaults to {}", async () => {
      expect(await validateExecute(catalog, { input: {}, skill: "release_notes" })).toEqual({
        value: { skill: "release_notes" },
      });
    });

    it("runs a tool that shares a skill's name, since tools and skills have separate names", async () => {
      expect(
        await validateExecute(catalog, { input: { invoiceId: "in_1" }, tool: "refund_invoice" }),
      ).toEqual({ value: { input: { invoiceId: "in_1" }, tool: "refund_invoice" } });
    });

    it("reports invalid input as the entry's own issues under input, with its signature", async () => {
      expect(
        await validateExecute(catalog, { input: { invoice: 1 }, tool: "refund_invoice" }),
      ).toEqual({
        issues: [
          { message: 'Unrecognized key: "invoice"', path: ["input"] },
          {
            message: "Signature: refund_invoice(input: { invoiceId: string }): Promise<unknown>",
            path: ["input"],
          },
        ],
      });
    });
  });

  describe("connection entries", () => {
    const listIssues = connectionTool("list_issues", {
      type: "object",
      properties: { team: { type: "string" }, limit: { type: "integer", default: 20 } },
      required: ["team"],
      additionalProperties: false,
    });

    function linearCatalog(listing?: Parameters<typeof fakeConnection>[0]["listing"]) {
      const linear = fakeConnection({
        listing,
        name: "linear",
        tools: [listIssues, connectionTool("list_projects")],
      });
      return { linear, ...catalogContext({ connections: [linear], tools: [inlineTool("add")] }) };
    }

    it("resolves a name under a connection's prefix to that connection's tool, filling schema defaults", async () => {
      const { catalog, linear, run } = linearCatalog();
      const validated = { input: { limit: 20, team: "core" }, tool: "linear__list_issues" };

      expect(
        await validateExecute(catalog, { input: { team: "core" }, tool: "linear__list_issues" }),
      ).toEqual({ value: validated });
      const resolved = catalog.resolve({ input: validated, toolName: EXECUTE_TOOL_NAME });
      expect(resolved?.call.toolName).toBe("linear__list_issues");
      expect(resolved?.definition.label?.start?.({})).toBe("Linear: List issues");
      await run(() =>
        resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "call-1" }),
      );
      expect(linear.calls).toEqual([{ input: { limit: 20, team: "core" }, tool: "list_issues" }]);
    });

    it("validates input against the connection's schema before the call can run", async () => {
      const { catalog, linear } = linearCatalog();

      expect(
        await validateExecute(catalog, { input: { team: 7 }, tool: "linear__list_issues" }),
      ).toEqual({
        issues: [
          {
            message: 'Instance type "number" is invalid. Expected "string".',
            path: ["input", "team"],
          },
          {
            message:
              "Signature: linear__list_issues(input: { team: string; limit?: number /* default: 20 */ }): Promise<unknown>",
            path: ["input"],
          },
        ],
      });
      expect(linear.calls).toEqual([]);
    });

    it.each([
      [
        "an unknown tool, with the connection's closest tools",
        undefined,
        'Connection "linear" has no tool named "list_issue". Closest tools: linear__list_issues, linear__list_projects.',
      ],
      [
        "a listing failure that is not a sign-in",
        new Error("upstream returned 502"),
        'Failed to load tools for "linear": upstream returned 502',
      ],
    ])("rejects %s", async (_case, listing, message) => {
      const { catalog } = linearCatalog(listing);
      const tool = listing === undefined ? "linear__list_issue" : "linear__list_issues";

      expect(await validateExecute(catalog, { tool })).toEqual({
        issues: [{ message, path: ["input"] }],
      });
    });

    it("accepts a call to a connection that needs sign-in, so the call can start it", async () => {
      const { catalog } = linearCatalog("sign-in");

      expect(
        await validateExecute(catalog, { input: { team: 7 }, tool: "linear__list_issues" }),
      ).toEqual({ value: { input: { team: 7 }, tool: "linear__list_issues" } });
    });
  });

  describe("connection sign-in", () => {
    function notionCatalog(
      options: Pick<
        Parameters<typeof fakeConnection>[0],
        "listing" | "rejectsToken" | "signIn"
      > = {},
    ) {
      const notion = fakeConnection({
        description: "Notion pages",
        listing: "sign-in",
        name: "notion",
        signIn: true,
        ...options,
        tools: [connectionTool("search_pages")],
      });
      const context = catalogContext({ connections: [notion] });
      const signIn = context.catalog.resolve({
        input: { tool: "notion" },
        toolName: EXECUTE_TOOL_NAME,
      })!;
      return {
        ...context,
        notion,
        signIn,
        connect: () =>
          context.run(() =>
            signIn.definition.execute!(signIn.call.input, { messages: [], toolCallId: "connect" }),
          ),
        /** Delivers the finished sign-in, as the turn step does when its callback arrives. */
        finishSignIn: () =>
          context.ctx.set(PendingAuthorizationResultKey, [
            {
              callback: { method: "GET", params: { code: "ok" } },
              hookUrl: "https://agent.example.com/callback",
              name: "notion",
            },
          ]),
      };
    }

    it("parks execute({ tool: <connection> }) for sign-in, then reports the sign-in and lists the tools", async () => {
      const { catalog, connect, finishSignIn, notion, run, signIn } = notionCatalog();

      expect(signIn.call.toolName).toBe("notion");
      expect(signIn.definition.label?.start?.({})).toBe("Sign in to Notion");
      expect(signIn.definition.approval).toBeUndefined();
      const parked = await connect();
      expect(isAuthorizationSignal(parked)).toBe(true);
      expect(parked).toMatchObject({ challenges: [{ name: "notion" }] });
      expect(notion.signIns).toHaveLength(1);

      finishSignIn();
      expect(await connect()).toBe(
        'Signed in to Notion. Find the Notion tools with eve__search({ query: "notion__" }).',
      );
      expect(notion.signIns).toHaveLength(1);
      const search = catalog.advertised.get(SEARCH_TOOL_NAME)!;
      expect(
        await run(() =>
          search.execute!({ query: "notion__" }, { messages: [], toolCallId: "find" }),
        ),
      ).toMatchObject({ results: [{ tool: "notion__search_pages" }] });
    });

    it("confirms a connection whose tools are already listable, without prompting", async () => {
      const { connect, notion } = notionCatalog({ listing: "listed" });

      expect(await connect()).toBe(
        'The Notion tools are available. Find them with eve__search({ query: "notion__" }).',
      );
      expect(notion.signIns).toEqual([]);
    });

    it("fails rather than asking again when the service rejects the token it just issued", async () => {
      const { connect, finishSignIn, notion } = notionCatalog({ rejectsToken: true });

      await connect();
      finishSignIn();

      await expect(connect()).rejects.toThrow(
        'Authorization failed for "notion": the service rejected the token immediately after authorization.',
      );
      expect(notion.signIns).toHaveLength(1);
    });

    it.each([
      [
        "a connection that cannot start sign-in",
        { signIn: false },
        '"notion" requires authorization and cannot start interactive sign-in.',
      ],
      [
        "a listing failure",
        { listing: new Error("upstream returned 502") },
        'Failed to load tools for "notion": upstream returned 502',
      ],
    ])("fails for %s", async (_case, options, message) => {
      captureLogRecords();
      await expect(notionCatalog(options).connect()).rejects.toThrow(message);
    });
  });
});
