import { describe, expect, it } from "vitest";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import {
  catalogBundle,
  connectionRegistry,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  toolMap,
  workflowTool,
  type CatalogSkillSource,
  type FakeConnection,
} from "#internal/testing/catalog-fixtures.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

import { buildStepCatalog } from "./step-catalog.js";

const ROOT = { rootSessionId: undefined };
const CHILD = { rootSessionId: "root-session" };

function catalogFor(
  tools: HarnessToolMap,
  options: {
    readonly connections?: readonly FakeConnection[];
    readonly dynamicSubagents?: readonly string[];
    readonly session?: { readonly rootSessionId: string | undefined };
    readonly skills?: readonly CatalogSkillSource[];
  } = {},
) {
  const ctx = new ContextContainer();
  ctx.set(
    BundleKey,
    catalogBundle({ dynamicSubagents: options.dynamicSubagents, skills: options.skills }),
  );
  if (options.connections !== undefined) {
    ctx.set(ConnectionRegistryKey, connectionRegistry(options.connections));
  }
  const catalog = buildStepCatalog({
    agentTools: tools,
    ctx,
    endsTurn: true,
    session: options.session ?? ROOT,
  });
  return {
    catalog,
    /** Validates `input` against the `execute` schema, which every call passes before it runs. */
    check: (input: unknown) =>
      contextStorage.run(ctx, async () => {
        const schema = catalog.advertised.get("execute")!.inputSchema as StandardSchemaV1;
        return await schema["~standard"].validate(input);
      }),
    run: <T>(fn: () => T) => contextStorage.run(ctx, fn),
  };
}

async function executeError(
  check: ReturnType<typeof catalogFor>["check"],
  input: unknown,
): Promise<string> {
  const checked = await check(input);
  if (checked.issues === undefined) throw new Error("Expected invalid input.");
  return checked.issues.map((issue) => issue.message).join("\n");
}

const names = (tools: ReadonlyMap<string, HarnessToolDefinition>) => [...tools.keys()];

describe("buildStepCatalog", () => {
  it("lists direct entries, then search and execute, and keeps deferred entries out of the tool list", () => {
    const { catalog } = catalogFor(
      toolMap(inlineTool("add"), inlineTool("refund_invoice", { deferred: true })),
    );

    expect(names(catalog.advertised)).toEqual(["add", "search", "execute"]);
    expect(names(catalog.deferred)).toEqual(["refund_invoice"]);
  });

  it("hides root-only entries, direct or deferred, from delegated sessions", () => {
    const tools = toolMap(
      inlineTool("add"),
      inlineTool("notify_team", { availableInSubagents: false }),
      inlineTool("billing", { behavior: { availability: ["root-session"] } }),
      inlineTool("archive", { availableInSubagents: false, deferred: true }),
      subagentTool("agent", { rootOnly: true }),
      subagentTool("delegate"),
      subagentTool("researcher", { deferred: true }),
    );

    const root = catalogFor(tools).catalog;
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

    const child = catalogFor(tools, { session: CHILD });
    expect(names(child.catalog.advertised)).toEqual([
      "add",
      "delegate",
      "task_wait",
      "task_cancel",
      "search",
      "execute",
    ]);
    expect(names(child.catalog.deferred)).toEqual(["researcher"]);
  });

  it("does not reach an entry hidden from a delegated session through execute", async () => {
    const { check } = catalogFor(
      toolMap(inlineTool("archive", { availableInSubagents: false, deferred: true })),
      { session: CHILD },
    );

    expect(await executeError(check, { tool: "archive" })).toContain(
      'No tool named "archive". Find tools with search.',
    );
  });

  describe("task tools", () => {
    const offered = (catalog: ReturnType<typeof catalogFor>["catalog"]) => ({
      advertised: catalog.advertised.has("task_wait") && catalog.advertised.has("task_cancel"),
      offersTasks: catalog.offersTasks,
    });

    it("are offered while a tool the session sees starts tasks, deferred or not", () => {
      expect(offered(catalogFor(toolMap(inlineTool("add"))).catalog)).toEqual({
        advertised: false,
        offersTasks: false,
      });
      expect(offered(catalogFor(toolMap(workflowTool("deploy_service"))).catalog).offersTasks).toBe(
        false,
      );
      expect(
        offered(catalogFor(toolMap(workflowTool("research", "task", { deferred: true }))).catalog),
      ).toEqual({ advertised: true, offersTasks: true });
      expect(offered(catalogFor(toolMap(subagentTool("delegate"))).catalog).offersTasks).toBe(true);
    });

    it("are not offered to a leaf subagent session whose only task-starting tool is root-only", () => {
      const tools = toolMap(inlineTool("add"), subagentTool("agent", { rootOnly: true }));

      expect(offered(catalogFor(tools).catalog).offersTasks).toBe(true);
      expect(offered(catalogFor(tools, { session: CHILD }).catalog)).toEqual({
        advertised: false,
        offersTasks: false,
      });
    });

    it("are offered when the agent resolves subagents at runtime", () => {
      const { catalog } = catalogFor(toolMap(inlineTool("add")), {
        dynamicSubagents: ["specialist"],
      });

      expect(offered(catalog)).toEqual({ advertised: true, offersTasks: true });
    });
  });

  describe("resolve", () => {
    const tools = toolMap(
      inlineTool("add"),
      inlineTool("refund_invoice", { deferred: true }),
      subagentTool("billing_specialist", { deferred: true }),
    );
    const skills = [{ name: "pdf-forms", deferred: true, markdown: "# PDF forms" }];

    it("resolves a call through execute to the entry it names, keeping the model's call id", () => {
      const { catalog } = catalogFor(tools, { skills });
      const call = {
        input: { input: { invoiceId: "in_1" }, tool: "refund_invoice" },
        toolCallId: "call-1",
        toolName: "execute",
      };

      expect(catalog.resolve(call)).toEqual({
        call: { input: { invoiceId: "in_1" }, toolCallId: "call-1", toolName: "refund_invoice" },
        definition: tools.get("refund_invoice"),
      });
      expect(
        catalog.resolve({ input: { tool: "billing_specialist" }, toolName: "execute" })?.call,
      ).toEqual({ input: {}, toolName: "billing_specialist" });
    });

    it("resolves execute({ skill }) to the skill loader, which returns the skill's markdown", async () => {
      const { catalog } = catalogFor(tools, { skills });

      const resolved = catalog.resolve({ input: { skill: "pdf-forms" }, toolName: "execute" });

      expect(resolved?.call).toEqual({ input: { skill: "pdf-forms" }, toolName: "eve:load-skill" });
      expect(
        await resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "" }),
      ).toBe("# PDF forms");
    });

    it("resolves a direct call only to a listed tool", () => {
      const { catalog } = catalogFor(tools, { skills });

      expect(catalog.resolve({ input: {}, toolName: "add" })?.definition).toBe(tools.get("add"));
      expect(catalog.resolve({ input: {}, toolName: "refund_invoice" })).toBeUndefined();
      expect(catalog.resolve({ input: { tool: "add" }, toolName: "execute" })).toBeUndefined();
    });
  });

  describe("execute validation", () => {
    const tools = toolMap(
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
    );
    const skills = [
      { name: "release_notes", deferred: true },
      { name: "release-checklist" },
      { name: "refund_invoice", deferred: true },
    ];

    it.each([
      [
        "an unknown tool, with the closest names",
        { tool: "refund_invoce" },
        'No tool named "refund_invoce". Closest tools: refund_invoice, refund_payment.',
      ],
      [
        "an unknown tool with no close names",
        { tool: "weather" },
        'No tool named "weather". Find tools with search.',
      ],
      [
        "a tool in the model's tool list",
        { tool: "add" },
        '"add" is in your tool list; call it directly.',
      ],
      ["execute itself", { tool: "execute" }, '"execute" is in your tool list; call it directly.'],
      [
        "an unknown skill, with the closest names",
        { skill: "release" },
        'No skill named "release". Closest skills: release_notes, release-checklist.',
      ],
      ["neither tool nor skill", {}, "Pass `tool`, or `skill` to load a skill."],
      [
        "both tool and skill",
        { skill: "release_notes", tool: "refund_payment" },
        "Pass either `tool` or `skill`, not both.",
      ],
      [
        "input with a skill",
        { input: {}, skill: "release_notes" },
        "`input` goes only with `tool`.",
      ],
    ])("rejects %s", async (_case, input, message) => {
      const { check } = catalogFor(tools, { skills });

      expect(await executeError(check, input)).toContain(message);
    });

    it("tells the model to load a skill named as a tool when no tool has its name", async () => {
      const { check } = catalogFor(tools, { skills });

      expect(await executeError(check, { tool: "release_notes" })).toContain(
        '"release_notes" is a skill; load it with execute({ skill: "release_notes" }).',
      );
      // Skills and tools have separate names, so a tool sharing a skill's name still runs.
      expect(await check({ input: { invoiceId: "in_1" }, tool: "refund_invoice" })).toEqual({
        value: { input: { invoiceId: "in_1" }, tool: "refund_invoice" },
      });
    });

    it("returns the entry's signature with invalid input", async () => {
      const { check } = catalogFor(tools, { skills });

      const message = await executeError(check, { input: { invoice: 1 }, tool: "refund_invoice" });

      expect(message).toContain('Invalid input for tool "refund_invoice"');
      expect(message).toContain("Signature: refund_invoice(input: { invoiceId: string })");
    });

    it("says a skill named like a connection is a connection", async () => {
      const linear = fakeConnection({ name: "linear", tools: [] });
      const { check } = catalogFor(tools, { connections: [linear], skills });

      expect(await executeError(check, { skill: "Linear" })).toContain(
        '"linear" is a connection, not a skill. Find its tools with search({ connection: "linear" }).',
      );
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
      return { linear, ...catalogFor(toolMap(inlineTool("add")), { connections: [linear] }) };
    }

    it("resolves a name under a connection's prefix to that connection's tool, filling schema defaults", async () => {
      const { catalog, check, linear, run } = linearCatalog();
      const input = { input: { team: "core" }, tool: "linear__list_issues" };

      const validated = { input: { limit: 20, team: "core" }, tool: "linear__list_issues" };
      expect(await check(input)).toEqual({ value: validated });
      const resolved = catalog.resolve({ input: validated, toolName: "execute" });
      expect(resolved?.call.toolName).toBe("linear__list_issues");
      expect(resolved?.definition.label?.start?.({})).toBe("Linear: List issues");
      await run(() =>
        resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "call-1" }),
      );
      expect(linear.calls).toEqual([{ input: { limit: 20, team: "core" }, tool: "list_issues" }]);
    });

    it("validates input against the connection's schema before the call can run", async () => {
      const { check, linear } = linearCatalog();

      const message = await executeError(check, {
        input: { team: 7 },
        tool: "linear__list_issues",
      });

      expect(message).toContain("team: Instance type");
      expect(message).toContain(
        "Signature: linear__list_issues(input: { team: string; limit?: number /* default: 20 */ })",
      );
      expect(linear.calls).toEqual([]);
    });

    it("suggests the connection's closest tools for an unknown one", async () => {
      const { check } = linearCatalog();

      const message = await executeError(check, { tool: "linear__list_issue" });

      expect(message).toContain("has no tool named");
      expect(message).toContain("Closest tools: linear__list_issues, linear__list_projects.");
    });

    it("reports a listing failure that is not a sign-in", async () => {
      const { check } = linearCatalog(new Error("upstream returned 502"));

      const message = await executeError(check, { tool: "linear__list_issues" });

      expect(message).toContain("Failed to load tools for");
      expect(message).toContain("upstream returned 502");
    });

    it("accepts a call to a connection that needs sign-in, so the call can start it", async () => {
      const { check } = linearCatalog("sign-in");

      expect(await check({ input: { team: 7 }, tool: "linear__list_issues" })).toEqual({
        value: { input: { team: 7 }, tool: "linear__list_issues" },
      });
    });
  });
});
