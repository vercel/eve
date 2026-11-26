import { beforeAll, describe, expect, it, vi } from "vitest";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { isAuthorizationSignal, PendingAuthorizationResultKey } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { ContextContainer } from "#context/container.js";
import {
  catalogBundle,
  catalogContext,
  nativeCatalog,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  toolMap,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

import { writeDefinitionsState } from "#definitions/state.js";
import { evaluateStepValues } from "#definitions/step.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineJsonSchema, serializeInputSchema, type ToolSchemaSource } from "#tools/schema.js";
import { always } from "#tools/approval/policies.js";

import type { StepCatalog } from "./step-catalog.js";
import { labelCallbacks } from "#internal/testing/tool-labels.js";

const CHILD = { rootSessionId: "root-session" };

const names = (tools: ReadonlyMap<string, HarnessToolDefinition>) => [...tools.keys()];

function validate(catalog: StepCatalog, tool: string, input: unknown) {
  const schema = catalog.advertised.get(tool)!.inputSchema as StandardSchemaV1;
  return schema["~standard"].validate(input);
}
const validateTool = (catalog: StepCatalog, input: unknown) =>
  validate(catalog, CALL_TOOL_NAME, input);
const validateSkill = (catalog: StepCatalog, input: unknown) =>
  validate(catalog, SKILL_TOOL_NAME, input);

function shape(catalog: StepCatalog, tool: string) {
  const definition = catalog.advertised.get(tool)!;
  const schema = serializeInputSchema(definition.inputSchema as ToolSchemaSource) as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  return {
    description: definition.description,
    fields: Object.keys(schema.properties),
    required: schema.required,
  };
}

const LISTED_SKILL_DESCRIPTION =
  "Load a skill's instructions when the request clearly matches one of your listed skills or the user asks for it, then follow them.";
const CALL_DESCRIPTION =
  "Call a tool that isn't in your tool list by its exact name from eve__search, with `input` matching its signature.";

describe("buildStepCatalog", () => {
  it("lists direct entries, then the catalog tools, and keeps deferred entries out of the tool list", async () => {
    const { catalog } = await catalogContext({
      tools: [inlineTool("add"), inlineTool("refund_invoice", { deferred: true })],
    });

    expect(names(catalog.advertised)).toEqual(["add", SEARCH_TOOL_NAME, CALL_TOOL_NAME]);
    expect(names(catalog.deferred)).toEqual(["refund_invoice"]);
  });

  describe("which catalog tools the agent gets", () => {
    it("counts only the deferred tools the session sees, so a delegated session doesn't search for root-only ones", async () => {
      const tools = [inlineTool("archive", { availableInSubagents: false, deferred: true })];

      expect(names((await catalogContext({ tools })).catalog.advertised)).toEqual([
        SEARCH_TOOL_NAME,
        CALL_TOOL_NAME,
      ]);
      expect(names((await catalogContext({ session: CHILD, tools })).catalog.advertised)).toEqual(
        [],
      );
    });

    it("gives an agent with nothing to find, call, or load no catalog tools", async () => {
      const { catalog } = await catalogContext({ tools: [inlineTool("add")] });

      expect(names(catalog.advertised)).toEqual(["add"]);
    });

    it("gives an agent with only listed skills eve__skill alone, which never mentions search", async () => {
      const { catalog } = await catalogContext({ skills: [{ name: "house-rules" }] });

      expect(names(catalog.advertised)).toEqual([SKILL_TOOL_NAME]);
      expect(shape(catalog, SKILL_TOOL_NAME)).toEqual({
        description: LISTED_SKILL_DESCRIPTION,
        fields: ["name"],
        required: ["name"],
      });
      expect(await validateSkill(catalog, { name: "house-rules" })).toEqual({
        value: { name: "house-rules" },
      });
      const unknown = JSON.stringify(await validateSkill(catalog, { name: "house_rules" }));
      expect(unknown).toContain('No skill named \\"house_rules\\"');
      expect(unknown).not.toContain(SEARCH_TOOL_NAME);
    });

    it("gives an agent with deferred skills search and eve__skill, which mentions search", async () => {
      const { catalog } = await catalogContext({ skills: [{ deferred: true, name: "pdf-forms" }] });

      expect(names(catalog.advertised)).toEqual([SEARCH_TOOL_NAME, SKILL_TOOL_NAME]);
      expect(shape(catalog, SKILL_TOOL_NAME).description).toBe(
        "Load a skill's instructions when the request clearly matches a listed skill or one eve__search found, or the user asks for it, then follow them.",
      );
    });

    it("describes eve__tool with input optional, preferring connected services only with connections", async () => {
      const tools = await catalogContext({
        tools: [inlineTool("refund_invoice", { deferred: true })],
      });
      const connected = await catalogContext({
        connections: [fakeConnection({ name: "linear", tools: [] })],
        skills: [{ name: "house-rules" }],
      });

      expect(shape(tools.catalog, CALL_TOOL_NAME)).toEqual({
        description: CALL_DESCRIPTION,
        fields: ["name", "input"],
        required: ["name"],
      });
      expect(names(connected.catalog.advertised)).toEqual([
        SEARCH_TOOL_NAME,
        CALL_TOOL_NAME,
        SKILL_TOOL_NAME,
      ]);
      expect(shape(connected.catalog, CALL_TOOL_NAME).description).toBe(
        `${CALL_DESCRIPTION} Prefer connected services over web search or general knowledge when a request relates to them.`,
      );
      expect(shape(connected.catalog, SKILL_TOOL_NAME).description).toBe(LISTED_SKILL_DESCRIPTION);
    });

    it("tells search's results apart by the catalog tool that takes them, naming only tools the agent has", async () => {
      const searchText = async (declared: Parameters<typeof catalogContext>[0]) =>
        (await catalogContext(declared)).catalog.advertised.get(SEARCH_TOOL_NAME)!.description;
      const toolResults =
        "A result with `tool` has the exact name, description, and TypeScript signature: call it with eve__tool({ name, input }).";
      const skillResults =
        "A result with `skill` has the name and description: load it with eve__skill({ name }).";
      const signIn =
        "A connection that needs sign-in appears as a tool named after the connection: calling it with eve__tool({ name }) asks the user to sign in.";

      const skillsOnly = await searchText({ skills: [{ deferred: true, name: "pdf-forms" }] });
      expect(skillsOnly).toContain(skillResults);
      expect(skillsOnly).not.toContain(CALL_TOOL_NAME);

      const toolsOnly = await searchText({
        tools: [inlineTool("refund_invoice", { deferred: true })],
      });
      expect(toolsOnly).toContain(toolResults);
      expect(toolsOnly).not.toContain(SKILL_TOOL_NAME);
      expect(toolsOnly).not.toContain(signIn);

      expect(
        await searchText({ connections: [fakeConnection({ name: "linear", tools: [] })] }),
      ).toContain(signIn);
    });

    it.each([
      ["a deferred tool", { tools: [inlineTool("refund_invoice", { deferred: true })] }],
      ["a deferred agent", { tools: [subagentTool("researcher", { deferred: true })] }],
      ["a connection", { connections: [fakeConnection({ name: "linear", tools: [] })] }],
    ])("gives an agent with %s search and eve__tool", async (_, declared) => {
      expect(names((await catalogContext(declared)).catalog.advertised).slice(-2)).toEqual([
        SEARCH_TOOL_NAME,
        CALL_TOOL_NAME,
      ]);
    });

    it("gives an agent no catalog tools for dynamic resolvers that returned nothing they reach", async () => {
      const bundle = catalogBundle({ dynamicSubagents: ["helper"] });
      const ctx = new ContextContainer();
      ctx.set(
        SessionAgentKey,
        fromCompiledBundle({
          ...bundle,
          resolvedAgent: {
            ...bundle.resolvedAgent,
            definitions: [{ kind: "connection" }, { kind: "skill" }, { kind: "tool" }],
          } as never,
        }),
      );
      const catalog = await nativeCatalog({
        agentTools: toolMap(inlineTool("add")),
        ctx,
        endsTurn: true,
        session: {},
      });

      expect(names(catalog.advertised)).toEqual([
        "add",
        TASK_WAIT_TOOL_NAME,
        TASK_CANCEL_TOOL_NAME,
      ]);
    });

    it("keeps the catalog tools a model call offered, unchanged, once nothing reaches them", async () => {
      const { catalog: reachingEverything, ctx } = await catalogContext({
        connections: [fakeConnection({ name: "linear", tools: [] })],
        skills: [{ deferred: true, name: "pdf-forms" }],
        tools: [inlineTool("refund_invoice", { deferred: true })],
      });
      enterSessionProjection(ctx, undefined);
      await evaluateStepValues(
        {
          config: { tools: toolMap(inlineTool("refund_invoice", { deferred: true })) },
          ctx,
          finalReplyOnly: false,
          session: {},
        },
        { conversation: [] },
      );
      ctx.set(SessionAgentKey, fromCompiledBundle(catalogBundle({})));
      ctx.delete(ConnectionRegistryKey);
      const later = await nativeCatalog({
        agentTools: toolMap(inlineTool("add")),
        ctx,
        endsTurn: true,
        session: {},
      });
      const catalogTools = (catalog: StepCatalog) =>
        [SEARCH_TOOL_NAME, CALL_TOOL_NAME, SKILL_TOOL_NAME].map((tool) => shape(catalog, tool));

      expect(names(later.advertised)).toEqual([
        "add",
        SEARCH_TOOL_NAME,
        CALL_TOOL_NAME,
        SKILL_TOOL_NAME,
      ]);
      expect(catalogTools(later)).toEqual(catalogTools(reachingEverything));
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

    const root = (await catalogContext({ tools })).catalog;
    expect(names(root.advertised)).toEqual([
      "add",
      "notify_team",
      "billing",
      "agent",
      "delegate",
      TASK_WAIT_TOOL_NAME,
      TASK_CANCEL_TOOL_NAME,
      SEARCH_TOOL_NAME,
      CALL_TOOL_NAME,
    ]);
    expect(names(root.deferred)).toEqual(["archive", "researcher"]);

    const child = (await catalogContext({ session: CHILD, tools })).catalog;
    expect(names(child.advertised)).toEqual([
      "add",
      "delegate",
      TASK_WAIT_TOOL_NAME,
      TASK_CANCEL_TOOL_NAME,
      SEARCH_TOOL_NAME,
      CALL_TOOL_NAME,
    ]);
    expect(names(child.deferred)).toEqual(["researcher"]);
    expect(await validateTool(child, { name: "archive" })).toEqual({
      issues: [
        { message: 'No tool named "archive". Find tools with eve__search.', path: ["name"] },
      ],
    });
  });

  describe("task tools", () => {
    const offered = (catalog: StepCatalog) =>
      catalog.advertised.has(TASK_WAIT_TOOL_NAME) && catalog.advertised.has(TASK_CANCEL_TOOL_NAME);
    const offeredFor = async (...input: Parameters<typeof catalogContext>) =>
      offered((await catalogContext(...input)).catalog);
    const OFFERED = true;
    const NOT_OFFERED = false;

    it("are offered while a tool the session sees starts tasks, deferred or not", async () => {
      expect(await offeredFor({ tools: [inlineTool("add")] })).toEqual(NOT_OFFERED);
      expect(await offeredFor({ tools: [workflowTool("deploy_service")] })).toEqual(NOT_OFFERED);
      expect(
        await offeredFor({ tools: [workflowTool("research", "task", { deferred: true })] }),
      ).toEqual(OFFERED);
      expect(await offeredFor({ tools: [subagentTool("delegate")] })).toEqual(OFFERED);
      expect(
        await offeredFor({ dynamicSubagents: ["specialist"], tools: [inlineTool("add")] }),
      ).toEqual(OFFERED);
    });

    it("are omitted for a leaf subagent without task tools until a task starts, then stay offered after it ends", async () => {
      const tools = [inlineTool("add"), subagentTool("agent", { rootOnly: true })];

      expect(await offeredFor({ tools })).toEqual(OFFERED);
      expect(await offeredFor({ session: CHILD, tools })).toEqual(NOT_OFFERED);
      expect(
        await offeredFor({ session: CHILD, tasks: { task_1: { status: "running" } }, tools }),
      ).toEqual(OFFERED);
      expect(
        await offeredFor({ session: CHILD, tasks: { task_1: { status: "ended" } }, tools }),
      ).toEqual(OFFERED);
    });
  });

  describe("resolve", () => {
    const refundInvoice = inlineTool("refund_invoice", { deferred: true });
    const add = inlineTool("add");
    let catalog!: StepCatalog;
    beforeAll(async () => {
      ({ catalog } = await catalogContext({
        skills: [{ name: "pdf-forms", deferred: true, markdown: "# PDF forms" }],
        tools: [add, refundInvoice, subagentTool("billing_specialist", { deferred: true })],
      }));
    });

    it("resolves an eve__tool call to the entry it names, keeping the model's call id", async () => {
      const call = {
        input: { input: { invoiceId: "in_1" }, name: "refund_invoice" },
        toolCallId: "call-1",
        toolName: CALL_TOOL_NAME,
      };

      expect(catalog.resolve(call)).toEqual({
        call: { input: { invoiceId: "in_1" }, toolCallId: "call-1", toolName: "refund_invoice" },
        definition: refundInvoice,
      });
      expect(
        catalog.resolve({ input: { name: "billing_specialist" }, toolName: CALL_TOOL_NAME })?.call,
      ).toEqual({ input: {}, toolName: "billing_specialist" });
    });

    it("resolves an eve__skill call to the skill loader, which returns the skill's markdown", async () => {
      const resolved = catalog.resolve({ input: { name: "pdf-forms" }, toolName: SKILL_TOOL_NAME });

      expect(resolved?.call).toEqual({ input: { name: "pdf-forms" }, toolName: "eve:load-skill" });
      const label = labelCallbacks(resolved?.definition.label);
      expect(label?.start?.(resolved?.call.input)).toBe("Load skill pdf-forms");
      expect(label?.complete?.(resolved?.call.input, "# PDF forms")).toBe("Loaded skill pdf-forms");
      expect(
        await resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "" }),
      ).toBe("# PDF forms");
    });

    it("resolves a direct call only to a listed tool, and eve__tool to a listed tool too", async () => {
      expect(catalog.resolve({ input: {}, toolName: "add" })?.definition).toBe(add);
      expect(catalog.resolve({ input: {}, toolName: "refund_invoice" })).toBeUndefined();
      expect(
        catalog.resolve({ input: { input: { a: 1 }, name: "add" }, toolName: CALL_TOOL_NAME }),
      ).toEqual({ call: { input: { a: 1 }, toolName: "add" }, definition: add });
      expect(
        catalog.resolve({ input: { name: "refund_invoice" }, toolName: SKILL_TOOL_NAME }),
      ).toBeUndefined();
    });
  });

  describe("eve__tool and eve__skill validation", () => {
    let catalog!: StepCatalog;
    beforeAll(async () => {
      ({ catalog } = await catalogContext({
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
          workflowTool("research", "task"),
          inlineTool("bash", { frameworkTool: true }),
          subagentTool("billing_specialist", { frameworkTool: true }),
          {
            ...inlineTool("web_search"),
            behavior: {
              availability: [],
              handling: { kind: "provider-tool", provider: "parallel" },
            },
            execute: undefined,
          },
        ],
      }));
    });

    it.each([
      ["an authored tool", "add", {}],
      ["a built-in tool", "bash", {}],
      ["a static agent", "billing_specialist", { message: "Review Bob's dispute." }],
    ])(
      "eve__tool accepts %s in the model's tool list, with its own input",
      async (_case, name, input) => {
        expect(await validateTool(catalog, { input, name })).toEqual({ value: { input, name } });
      },
    );

    it.each([
      [
        "an unknown tool, with the closest names",
        "refund_invoce",
        'No tool named "refund_invoce". Closest tools: refund_invoice, refund_payment.',
      ],
      [
        "an unknown tool with no close names",
        "weather",
        'No tool named "weather". Find tools with eve__search.',
      ],
      [
        "eve__search",
        SEARCH_TOOL_NAME,
        `"${SEARCH_TOOL_NAME}" is in your tool list; call it directly.`,
      ],
      [
        "a task tool",
        TASK_WAIT_TOOL_NAME,
        `"${TASK_WAIT_TOOL_NAME}" is in your tool list; call it directly.`,
      ],
      [
        "a tool its provider runs",
        "web_search",
        '"web_search" is in your tool list; call it directly.',
      ],
      [
        "eve__tool itself",
        CALL_TOOL_NAME,
        `"${CALL_TOOL_NAME}" is in your tool list; call it directly.`,
      ],
      [
        "a skill named as a tool when no tool has its name",
        "release_notes",
        '"release_notes" is a skill; load it with eve__skill({ name: "release_notes" }).',
      ],
    ])("eve__tool rejects %s", async (_case, name, message) => {
      expect(await validateTool(catalog, { name })).toEqual({
        issues: [{ message, path: ["name"] }],
      });
    });

    it.each([
      [
        "an unknown skill, with the closest names",
        "release",
        'No skill named "release". Closest skills: release-checklist, release_notes.',
      ],
      [
        "a skill named like a connection",
        "Linear",
        'No skill named "Linear". Find skills with eve__search. "linear" is a connection, not a skill. Find its tools with eve__search({ query: "linear__" }).',
      ],
      [
        "a deferred tool's name",
        "refund_payment",
        '"refund_payment" is a tool, not a skill; call it with eve__tool({ name: "refund_payment" }).',
      ],
      [
        "a listed tool's name",
        "add",
        '"add" is a tool in your tool list, not a skill; call it directly.',
      ],
    ])("eve__skill rejects %s", async (_case, name, message) => {
      expect(await validateSkill(catalog, { name })).toEqual({
        issues: [{ message, path: ["name"] }],
      });
    });

    it.each([
      [
        CALL_TOOL_NAME,
        { input: {}, name: "eve__subscribe" },
        '"eve__subscribe" is in your tool list; call it directly.',
      ],
      [
        CALL_TOOL_NAME,
        { input: {}, name: "eve__subscription_stop" },
        '"eve__subscription_stop" is in your tool list; call it directly.',
      ],
      [
        SKILL_TOOL_NAME,
        { name: "eve__subscribe" },
        '"eve__subscribe" is a tool in your tool list, not a skill; call it directly.',
      ],
    ])("rejects a subscription tool listed on the agent via %s", async (tool, input, message) => {
      const { catalog: subscribed } = await catalogContext({
        channels: [{ name: "github", definition: { onEvent: () => null, catalog: () => [] } }],
        skills: [{ deferred: true, name: "release_notes" }],
        tools: [inlineTool("refund_invoice", { deferred: true })],
      });
      expect(await validate(subscribed, tool, input)).toEqual({
        issues: [{ message, path: ["name"] }],
      });
    });

    it("doesn't point eve__skill at eve__search when search can't find skills", async () => {
      const { catalog: toolSearch } = await catalogContext({
        skills: [{ name: "house-rules" }],
        tools: [inlineTool("refund_invoice", { deferred: true })],
      });

      expect(await validateSkill(toolSearch, { name: "weather" })).toEqual({
        issues: [{ message: 'No skill named "weather".', path: ["name"] }],
      });
    });

    it("calls the tool and loads the skill that share a name, since tools and skills have separate names", async () => {
      expect(
        await validateTool(catalog, { input: { invoiceId: "in_1" }, name: "refund_invoice" }),
      ).toEqual({ value: { input: { invoiceId: "in_1" }, name: "refund_invoice" } });
      expect(await validateSkill(catalog, { name: "refund_invoice" })).toEqual({
        value: { name: "refund_invoice" },
      });
    });

    it("reports invalid input as the entry's own issues under input, with its signature", async () => {
      expect(
        await validateTool(catalog, { input: { invoice: 1 }, name: "refund_invoice" }),
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

    async function linearCatalog(listing?: Parameters<typeof fakeConnection>[0]["listing"]) {
      const linear = fakeConnection({
        listing,
        name: "linear",
        tools: [listIssues, connectionTool("list_projects")],
      });
      return {
        linear,
        ...(await catalogContext({ connections: [linear], tools: [inlineTool("add")] })),
      };
    }

    it("resolves a name under a connection's prefix to that connection's tool, which fills schema defaults when it runs", async () => {
      const { catalog, linear, run } = await linearCatalog();
      const validated = { input: { team: "core" }, name: "linear__list_issues" };

      expect(
        await validateTool(catalog, { input: { team: "core" }, name: "linear__list_issues" }),
      ).toEqual({ value: validated });
      const resolved = catalog.resolve({ input: validated, toolName: CALL_TOOL_NAME });
      expect(resolved?.call.toolName).toBe("linear__list_issues");
      expect(labelCallbacks(resolved?.definition.label)?.start?.({})).toBe("Linear: List issues");
      await run(() =>
        resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "call-1" }),
      );
      expect(linear.calls).toEqual([{ input: { limit: 20, team: "core" }, tool: "list_issues" }]);
    });

    it("versions a dynamic connection's entries by its target and memo results", async () => {
      const { ctx } = await linearCatalog();
      const versionFor = async (tenant: string) => {
        writeDefinitionsState(ctx, {
          latest: {},
          memos: { "connection::linear": { tenant } },
          slots: {
            "connection::linear": {
              digest: "linear",
              since: 0,
              value: [{ name: "linear", protocol: "mcp", url: "https://linear.example" }],
            },
          },
        });
        const catalog = await nativeCatalog({
          agentTools: new Map(),
          ctx,
          endsTurn: false,
          session: {},
        });
        return [catalog.get("linear")?.version, catalog.get("linear__list_issues")?.version];
      };

      const [signIn, tool] = await versionFor("a");
      expect(signIn).toBeDefined();
      expect(tool).toBe(signIn);
      expect(await versionFor("a")).toEqual([signIn, tool]);
      expect((await versionFor("b"))[1]).not.toBe(tool);
      expect((await linearCatalog()).catalog.get("linear__list_issues")?.version).toBeUndefined();
    });

    it("fails a call whose connection doesn't list its tools within 10 seconds, when validating and when calling", async () => {
      vi.useFakeTimers();
      try {
        const { catalog, linear, run } = await linearCatalog();
        const listing = vi.spyOn(linear.client, "getToolMetadata");
        const timedOut = '"linear" did not list its tools within 10s. Try again later.';
        const call = { input: { team: "core" }, name: "linear__list_issues" };

        listing.mockReturnValueOnce(new Promise(() => {}));
        const validating = validateTool(catalog, call);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await validating).toEqual({
          issues: [expect.objectContaining({ message: timedOut })],
        });

        const { value } = (await validateTool(catalog, call)) as { value: unknown };
        const resolved = catalog.resolve({ input: value, toolName: CALL_TOOL_NAME });
        listing.mockReturnValueOnce(new Promise(() => {}));
        const calling = run(() =>
          resolved?.definition.execute?.(resolved.call.input, {
            messages: [],
            toolCallId: "call-1",
          }),
        );
        const rejected = expect(calling).rejects.toThrow(timedOut);
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        expect(linear.calls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      {
        case: "fails and cancels a call the connection doesn't answer within 5 minutes",
        cancelTurn: false,
        error:
          '"linear" did not answer list_issues within 5 minutes. It may still have run, so check before you retry.',
      },
      {
        case: "keeps the turn's own error when the turn is cancelled before the deadline",
        cancelTurn: true,
        error: "Request was aborted",
      },
    ])("$case", async ({ cancelTurn, error }) => {
      vi.useFakeTimers();
      try {
        const { catalog, linear, run } = await linearCatalog();
        let request: AbortSignal | undefined;
        vi.spyOn(linear.client, "executeTool").mockImplementationOnce(
          async (_tool, _args, { abortSignal }) =>
            await new Promise((_, reject) => {
              request = abortSignal;
              abortSignal?.addEventListener("abort", () =>
                reject(new Error("Request was aborted")),
              );
            }),
        );
        const call = { input: { team: "core" }, name: "linear__list_issues" };
        const { value } = (await validateTool(catalog, call)) as { value: unknown };
        const resolved = catalog.resolve({ input: value, toolName: CALL_TOOL_NAME });
        const turn = new AbortController();
        const calling = run(() =>
          resolved?.definition.execute?.(resolved.call.input, {
            abortSignal: turn.signal,
            messages: [],
            toolCallId: "call-1",
          }),
        );

        const outcome = Promise.resolve(calling).then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        if (cancelTurn) turn.abort();
        await vi.advanceTimersByTimeAsync(cancelTurn ? 0 : 4 * 60_000);
        expect(await Promise.race([outcome, "still waiting"])).toBe(error);
        expect(request?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("validates input against the connection's schema before the call can run", async () => {
      const { catalog, linear } = await linearCatalog();

      expect(
        await validateTool(catalog, { input: { team: 7 }, name: "linear__list_issues" }),
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

    it("accepts a key the connection provides when the model sends it anyway, since the provided value replaces it", async () => {
      const nova = fakeConnection({
        name: "nova",
        toolCall: { providedArguments: { env: "prod" } },
        tools: [
          connectionTool("loki_logs", {
            type: "object",
            properties: { logql: { type: "string" } },
            required: ["logql"],
            additionalProperties: false,
          }),
        ],
      });
      const { catalog, run } = await catalogContext({ connections: [nova] });
      const call = { input: { env: "staging", logql: '{app="api"}' }, name: "nova__loki_logs" };

      expect(await validateTool(catalog, call)).toEqual({
        value: { input: { logql: '{app="api"}' }, name: "nova__loki_logs" },
      });
      const resolved = catalog.resolve({ input: call, toolName: CALL_TOOL_NAME });
      await run(() =>
        resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "call-1" }),
      );
      expect(nova.calls).toEqual([{ input: { logql: '{app="api"}' }, tool: "loki_logs" }]);
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
      const { catalog } = await linearCatalog(listing);
      const tool = listing === undefined ? "linear__list_issue" : "linear__list_issues";

      expect(await validateTool(catalog, { name: tool })).toEqual({
        issues: [{ message, path: ["input"] }],
      });
    });

    it("accepts a call to a connection that needs sign-in, so the call can start it", async () => {
      const { catalog } = await linearCatalog("sign-in");

      expect(
        await validateTool(catalog, { input: { team: 7 }, name: "linear__list_issues" }),
      ).toEqual({ value: { input: { team: 7 }, name: "linear__list_issues" } });
    });
  });

  describe("connection sign-in", () => {
    async function notionCatalog(
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
      const context = await catalogContext({ connections: [notion] });
      const signIn = context.catalog.resolve({
        input: { name: "notion" },
        toolName: CALL_TOOL_NAME,
      })!;
      return {
        ...context,
        notion,
        signIn,
        connect: () =>
          context.run(() =>
            signIn.definition.execute!(signIn.call.input, { messages: [], toolCallId: "connect" }),
          ),
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

    it("parks eve__tool({ name: <connection> }) for sign-in, then reports the sign-in and lists the tools", async () => {
      const { catalog, connect, finishSignIn, notion, run, signIn } = await notionCatalog();

      expect(signIn.call.toolName).toBe("notion");
      expect(labelCallbacks(signIn.definition.label)?.start?.({})).toBe("Sign in to Notion");
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
      const { connect, notion } = await notionCatalog({ listing: "listed" });

      expect(await connect()).toBe(
        'The Notion tools are available. Find them with eve__search({ query: "notion__" }).',
      );
      expect(notion.signIns).toEqual([]);
    });

    it("fails rather than asking again when the service rejects the token it just issued", async () => {
      const { connect, finishSignIn, notion } = await notionCatalog({ rejectsToken: true });

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
      await expect((await notionCatalog(options)).connect()).rejects.toThrow(message);
    });
  });

  describe("workflow program tools", () => {
    it("annotates direct tools with output types only when a tools-enabled workflow tool is present and exempts it from agent-wide approval", async () => {
      const lookup = inlineTool("lookup_order", {
        description: "Look up one order.",
        outputSchema: defineJsonSchema({
          properties: { status: { type: "string" } },
          required: ["status"],
          type: "object",
        }),
      });
      const programTool: HarnessToolDefinition = {
        ...workflowTool("workflow", "execute"),
        workflowProgram: { maxSubagents: 10, tools: true },
      };

      const withoutProgram = await catalogContext({ approval: always(), tools: [lookup] });
      expect(
        withoutProgram.catalog.describe(withoutProgram.catalog.advertised.get("lookup_order")!),
      ).toBe("Look up one order.");

      const withProgram = await catalogContext({
        approval: always(),
        tools: [lookup, programTool],
      });
      expect(
        withProgram.catalog.describe(withProgram.catalog.advertised.get("lookup_order")!),
      ).toBe(
        "Look up one order.\n\nIn workflow programs, tools.lookup_order(input) resolves to: { status: string }",
      );
      expect(withProgram.catalog.advertised.get("lookup_order")?.approval).toBeDefined();
      const workflowApproval = withProgram.catalog.advertised.get("workflow")?.approval;
      expect(typeof workflowApproval).toBe("function");
      if (typeof workflowApproval === "function") {
        expect(
          await workflowApproval({
            callId: "c1",
            toolInput: { js: "return 1" },
            toolName: "workflow",
          } as never),
        ).toBe("approved");
      }

      const withDeniedProgram = await catalogContext({
        approval: () => ({ reason: "Blocked by policy.", type: "denied" }),
        tools: [programTool],
      });
      const deniedApproval = withDeniedProgram.catalog.advertised.get("workflow")?.approval;
      expect(typeof deniedApproval).toBe("function");
      if (typeof deniedApproval === "function") {
        expect(
          await deniedApproval({
            callId: "c2",
            toolInput: { js: "return 1" },
            toolName: "workflow",
          } as never),
        ).toEqual({ reason: "Blocked by policy.", type: "denied" });
      }
    });
  });

  describe("subscribe", () => {
    const channels = [{ name: "github", definition: { onEvent: () => null, catalog: () => [] } }];
    const subscribed = async () => {
      const tracker = fakeConnection({ name: "tracker", tools: [], events: ["build.finished"] });
      const { catalog, run } = await catalogContext({ channels, connections: [tracker] });
      return { catalog, run, tracker };
    };

    it("advertises eve__subscribe and eve__subscription_stop with eve__search, and not the connection's events as tools", async () => {
      const { catalog } = await subscribed();
      expect(names(catalog.advertised)).toEqual(
        expect.arrayContaining(["eve__search", "eve__subscribe", "eve__subscription_stop"]),
      );
      expect(names(catalog.advertised)).not.toContain("eve__subscription_get");
      expect(names(catalog.advertised).filter((name) => name.includes("events_"))).toEqual([]);
    });

    it("validates the flat input without fetching the connection's events", async () => {
      const { catalog, tracker } = await subscribed();
      const input = {
        source: "tracker",
        event: "build.finished",
        input: { job: "web" },
        ttlMs: 120_000,
      };
      expect(await validate(catalog, "eve__subscribe", input)).toEqual({ value: input });
      expect(await validate(catalog, "eve__subscribe", { subscription: input })).toHaveProperty(
        "issues",
      );
      expect(tracker.eventListCalls).toEqual([]);
    });

    it("subscribes a connection source with its own event action", async () => {
      const { catalog, run, tracker } = await subscribed();
      const input = {
        source: "tracker",
        event: "build.finished",
        input: { job: "web" },
        ttlMs: 120_000,
      };
      const resolved = catalog.resolve({ input, toolName: "eve__subscribe" });
      expect(resolved?.call.toolName).toBe("eve__subscribe");
      await run(() =>
        resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "call-1" }),
      );
      expect(tracker.eventCalls).toEqual([
        {
          name: "events_subscribe",
          input: { event: "build.finished", arguments: { job: "web" }, ttlMs: 120_000 },
        },
      ]);
    });

    it("finds a connection's events with eve__search only when searched", async () => {
      const { catalog, run, tracker } = await subscribed();
      expect(tracker.eventListCalls).toEqual([]);
      const search = catalog.resolve({
        input: { query: "subscriptions__tracker__" },
        toolName: "eve__search",
      });
      const found = (await run(() =>
        search?.definition.execute?.(search.call.input, { messages: [], toolCallId: "call-2" }),
      )) as { results: { event?: string; source?: string; signature?: string }[] };
      expect(found.results).toEqual([
        expect.objectContaining({ event: "build.finished", source: "tracker" }),
      ]);
      expect(found.results[0]?.signature).toContain("eve__subscribe(");
      expect(tracker.eventListCalls).toHaveLength(1);
    });

    it("finds a channel's events from code, without any connection", async () => {
      const github = {
        name: "github",
        definition: {
          onEvent: () => null,
          catalog: () => [
            {
              name: "check_suite.completed",
              description: "A check suite finished.",
              inputSchema: defineJsonSchema({
                type: "object",
                properties: { owner: { type: "string" } },
              }),
            },
            {
              name: "push",
              description: "A push.",
              inputSchema: defineJsonSchema({ type: "object" }),
            },
          ],
        },
      };
      const { catalog, run } = await catalogContext({ channels: [github] });
      const search = (query: string) => {
        const resolved = catalog.resolve({ input: { query }, toolName: "eve__search" });
        return run(() =>
          resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "c" }),
        ) as Promise<{ results: { event?: string }[] }>;
      };
      expect((await search("subscriptions__github__")).results.map(({ event }) => event)).toEqual([
        "check_suite.completed",
        "push",
      ]);
      expect((await search("github check suite")).results[0]).toMatchObject({
        event: "check_suite.completed",
        source: "github",
        description: "A check suite finished.",
      });
    });

    it("does not call a channel's catalog for a search in another namespace, and reports a channel whose catalog rejects as unavailable", async () => {
      const failing = vi.fn(async () => {
        throw new Error("registry down");
      });
      const healthy = vi.fn(() => [
        { name: "push", description: "A push.", inputSchema: defineJsonSchema({ type: "object" }) },
      ]);
      const { catalog, run } = await catalogContext({
        channels: [
          { name: "github", definition: { onEvent: () => null, catalog: failing } },
          { name: "slack", definition: { onEvent: () => null, catalog: healthy } },
        ],
      });
      const search = (query: string) => {
        const resolved = catalog.resolve({ input: { query }, toolName: "eve__search" });
        return run(() =>
          resolved?.definition.execute?.(resolved.call.input, { messages: [], toolCallId: "c" }),
        ) as Promise<{
          results: { event?: string }[];
          unavailable?: { connection: string; error: string }[];
        }>;
      };

      const scoped = await search("subscriptions__slack__");
      expect(scoped.results.map(({ event }) => event)).toEqual(["push"]);
      expect(scoped.unavailable).toBeUndefined();
      expect(failing).not.toHaveBeenCalled();

      const wide = await search("push");
      expect(wide.results.map(({ event }) => event)).toEqual(["push"]);
      expect(wide.unavailable).toEqual([
        {
          connection: "github",
          error: 'Failed to list the events of channel "github": registry down',
        },
      ]);
    });
  });
});
