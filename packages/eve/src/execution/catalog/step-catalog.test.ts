import { describe, expect, it } from "vitest";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  catalogContext,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";

import type { StepCatalog } from "./step-catalog.js";

const CHILD = { rootSessionId: "root-session" };

const names = (tools: ReadonlyMap<string, HarnessToolDefinition>) => [...tools.keys()];

/** Validates `input` against the `execute` schema, which every call passes before it runs. */
function validateExecute(catalog: StepCatalog, input: unknown) {
  const schema = catalog.advertised.get("execute")!.inputSchema as StandardSchemaV1;
  return schema["~standard"].validate(input);
}

describe("buildStepCatalog", () => {
  it("lists direct entries, then search and execute, and keeps deferred entries out of the tool list", () => {
    const { catalog } = catalogContext({
      tools: [inlineTool("add"), inlineTool("refund_invoice", { deferred: true })],
    });

    expect(names(catalog.advertised)).toEqual(["add", "search", "execute"]);
    expect(names(catalog.deferred)).toEqual(["refund_invoice"]);
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
      "task_wait",
      "task_cancel",
      "search",
      "execute",
    ]);
    expect(names(root.deferred)).toEqual(["archive", "researcher"]);

    const child = catalogContext({ session: CHILD, tools }).catalog;
    expect(names(child.advertised)).toEqual([
      "add",
      "delegate",
      "task_wait",
      "task_cancel",
      "search",
      "execute",
    ]);
    expect(names(child.deferred)).toEqual(["researcher"]);
    // A hidden entry can't be reached through execute either.
    expect(await validateExecute(child, { tool: "archive" })).toEqual({
      issues: [{ message: 'No tool named "archive". Find tools with search.', path: ["tool"] }],
    });
  });

  describe("task tools", () => {
    const offered = (catalog: StepCatalog) => ({
      advertised: catalog.advertised.has("task_wait") && catalog.advertised.has("task_cancel"),
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
        toolName: "execute",
      };

      expect(catalog.resolve(call)).toEqual({
        call: { input: { invoiceId: "in_1" }, toolCallId: "call-1", toolName: "refund_invoice" },
        definition: refundInvoice,
      });
      expect(
        catalog.resolve({ input: { tool: "billing_specialist" }, toolName: "execute" })?.call,
      ).toEqual({ input: {}, toolName: "billing_specialist" });
    });

    it("resolves execute({ skill }) to the skill loader, which returns the skill's markdown", async () => {
      const resolved = catalog.resolve({ input: { skill: "pdf-forms" }, toolName: "execute" });

      expect(resolved?.call).toEqual({ input: { skill: "pdf-forms" }, toolName: "eve:load-skill" });
      expect(
        await resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "" }),
      ).toBe("# PDF forms");
    });

    it("resolves a direct call only to a listed tool", () => {
      expect(catalog.resolve({ input: {}, toolName: "add" })?.definition).toBe(add);
      expect(catalog.resolve({ input: {}, toolName: "refund_invoice" })).toBeUndefined();
      expect(catalog.resolve({ input: { tool: "add" }, toolName: "execute" })).toBeUndefined();
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
        'No tool named "weather". Find tools with search.',
      ],
      [
        "a tool in the model's tool list",
        { tool: "add" },
        "tool",
        '"add" is in your tool list; call it directly.',
      ],
      [
        "execute itself",
        { tool: "execute" },
        "tool",
        '"execute" is in your tool list; call it directly.',
      ],
      [
        "a skill named as a tool when no tool has its name",
        { tool: "release_notes" },
        "tool",
        '"release_notes" is a skill; load it with execute({ skill: "release_notes" }).',
      ],
      [
        "an unknown skill, with the closest names",
        { skill: "release" },
        "skill",
        'No skill named "release". Closest skills: release_notes, release-checklist.',
      ],
      [
        "a skill named like a connection",
        { skill: "Linear" },
        "skill",
        'No skill named "Linear". Find skills with search. "linear" is a connection, not a skill. Find its tools with search({ connection: "linear" }).',
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
        { input: {}, skill: "release_notes" },
        "input",
        "`input` goes only with `tool`.",
      ],
    ])("rejects %s", async (_case, input, path, message) => {
      expect(await validateExecute(catalog, input)).toEqual({
        issues: [{ message, path: [path] }],
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
      const resolved = catalog.resolve({ input: validated, toolName: "execute" });
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
});
