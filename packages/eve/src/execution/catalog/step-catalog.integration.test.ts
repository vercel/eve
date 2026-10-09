import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { SessionIdKey, StaticModelReferenceKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mockModel } from "#evals/mock-model.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import {
  catalogBundle,
  connectionRegistry,
  connectionTool,
  fakeConnection,
  inlineTool,
  subagentTool,
  toolMap,
  workflowTool,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { parkedSteps } from "#internal/testing/session-machine.js";
import {
  createSessionStartedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { stampDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

/** The namespaces line once a dynamic `tenant__*` tool joins the static `ops__*` one. */
const NAMESPACES_OPS_TENANT = /^Namespaces, .*: ops, tenant$/mu;

/** Every catalog listing says this, whatever kinds it names. */
const LISTING_MARKER = "look for one with eve__search, which searches your own catalog";

type Reply = ReturnType<typeof textStreamResult>;

function call(toolCallId: string, toolName: string, input: unknown) {
  return { input: JSON.stringify(input), toolCallId, toolName };
}

const text = textStreamResult;
const calls = (...entries: ReturnType<typeof call>[]) => toolCallsStreamResult(entries);

/** Alice's session context, with what sign-in and dynamic subagents read. */
function createSessionContext(): ContextContainer {
  const ctx = createApprovalContext();
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(StaticModelReferenceKey, { id: "catalog-model" });
  return ctx;
}

/** One session on one harness; `drive` runs a step and every continuation it asks for. */
function createDriver(ctx: ContextContainer, tools: HarnessToolMap) {
  const replies: Reply[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The model script ran out of replies.");
      return reply;
    },
    modelId: "catalog-model",
    provider: "eve-integration-mock",
  });
  const summary = mockModel("Alice and Bob handled refunds, credits, deploys, and lookups.");
  const events: UnstampedMessageStreamEvent[] = [];
  const harness = createToolLoopHarness({
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async (reference) => (reference.id === "summary" ? summary : model),
    tools,
  });
  const sessionId = ctx.require(SessionIdKey);
  const driver = {
    events,
    reply: (...next: Reply[]) => replies.push(...next),
    requests: () => model.doStreamCalls as LanguageModelV4CallOptions[],
    session: {
      agent: {
        compactionModelReference: { id: "summary" },
        modelReference: { id: "catalog-model" },
        system: "Help Alice run the billing desk.",
        tools: [],
      },
      compaction: { recentWindowSize: 2, threshold: 1_000_000 },
      continuationToken: `http:${sessionId}`,
      history: [],
      sessionId,
    } as HarnessSession,
    async drive(input?: StepInput): Promise<StepResult> {
      const step = (stepInput?: StepInput) =>
        contextStorage.run(ctx, () => harness(driver.session, stepInput));
      let result = await step(input);
      driver.session = result.session;
      while (typeof result.next === "function") {
        result = await step();
        driver.session = result.session;
      }
      return result;
    },
  };
  return driver;
}

/** A message as the provider receives it, without per-request provider options. */
function messageKey(message: LanguageModelV4Prompt[number]): string {
  return JSON.stringify({ content: message.content, role: message.role });
}

function messageText(message: LanguageModelV4Prompt[number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => ("text" in part ? part.text : JSON.stringify(part)))
    .join("\n");
}

const systemText = (request: LanguageModelV4CallOptions) =>
  request.prompt.filter((message) => message.role === "system").map(messageText);
const conversation = (request: LanguageModelV4CallOptions) =>
  request.prompt.filter((message) => message.role !== "system").map(messageKey);

/** The catalog listing and diffs a request carries, in order. */
function catalogMessages(request: LanguageModelV4CallOptions): string[] {
  return request.prompt
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter((entry) => entry.includes(LISTING_MARKER) || entry.startsWith("The catalog changed"));
}

/** What the model read back for `callId`: a JSON value or error text. */
function toolResult(request: LanguageModelV4CallOptions, callId: string): unknown {
  for (const message of request.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === callId && "value" in part.output) {
        return part.output.value;
      }
    }
  }
  throw new Error(`No result for ${callId} in the request.`);
}

/** Every tool-result part for `callId` in the request's prompt. */
function toolResultParts(
  request: LanguageModelV4CallOptions,
  callId: string,
): LanguageModelV4ToolResultPart[] {
  return request.prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part): part is LanguageModelV4ToolResultPart =>
            part.type === "tool-result" && part.toolCallId === callId,
        )
      : [],
  );
}

/** A dynamic tool, stamped with the durable callback the bundler adds to authored resolvers. */
function dynamicTool(description: string) {
  const entry = defineTool({
    deferred: true,
    description,
    execute: async () => ({ synced: true }),
    inputSchema: { type: "object" },
  });
  stampDurableDynamicToolCallbacks(entry, {
    execute: { callback: () => ({ synced: true }), closure: {} },
  });
  return entry;
}

describe("step catalog in the harness (real AI SDK)", () => {
  it("keeps the six cache invariants while one session reaches every kind of entry", async () => {
    const ctx = createSessionContext();
    const privateCatalog = fakeConnection({
      description: "Private catalog that needs sign-in.",
      listing: "sign-in",
      name: "private",
      signIn: true,
      tools: [connectionTool("list_items")],
    });
    const connections = [privateCatalog];
    ctx.set(ConnectionRegistryKey, connectionRegistry(connections));
    ctx.set(
      BundleKey,
      catalogBundle({
        skills: [
          { deferred: true, description: "Fill and validate PDF forms.", name: "pdf-forms" },
          { deferred: true, description: "How to write release notes.", name: "release_notes" },
          {
            description: "House rules for replies.",
            markdown: "# House rules",
            name: "house-rules",
          },
        ],
      }),
    );
    const tools = toolMap(
      inlineTool("add"),
      inlineTool("refund_invoice", {
        deferred: true,
        schema: {
          type: "object",
          properties: { invoiceId: { type: "string" } },
          required: ["invoiceId"],
        },
      }),
      inlineTool("issue_credit", { approval: always(), deferred: true }),
      inlineTool("release_notes", { deferred: true, description: "Publish release notes." }),
      inlineTool("ops__restart", { deferred: true, description: "Restart an ops service." }),
      workflowTool("deploy_service", "execute", { deferred: true }),
      workflowTool("research", "task", { deferred: true }),
      subagentTool("billing_specialist", { deferred: true }),
    );
    const driver = createDriver(ctx, tools);
    const { drive, reply } = driver;
    const mark = () => driver.requests().length;
    let tenantSyncAvailable = true;
    const resolveTenantTools = () =>
      dispatchDynamicToolEvent({
        ctx,
        event: createSessionStartedEvent(),
        messages: [],
        resolvers: [
          {
            eventNames: ["session.started"],
            events: {
              "session.started": () =>
                tenantSyncAvailable ? { tenant__sync: dynamicTool("Sync the tenant.") } : null,
            },
            logicalPath: "agent/tools/tenant.ts",
            slug: "tenant",
            sourceId: "tools/tenant.ts",
            sourceKind: "module",
          },
        ],
      });

    // A search, then an inline tool through eve__tool.
    reply(
      calls(call("search-refund", SEARCH_TOOL_NAME, { query: "refund" })),
      calls(
        call("refund", CALL_TOOL_NAME, { input: { invoiceId: "in_1" }, name: "refund_invoice" }),
      ),
      text("Refunded in_1."),
    );
    await drive({ message: "Alice asks for a refund of invoice in_1." });

    // An approval, during which a dynamic deferred tool appears. The catalog
    // changes on the step that runs the approved call.
    reply(calls(call("credit", CALL_TOOL_NAME, { name: "issue_credit" })));
    const awaitingApproval = await drive({ message: "Alice asks for a credit for Bob." });
    const [approval] = parkedSteps(awaitingApproval.session).flatMap((step) => step.requests);
    expect(approval?.action.toolName).toBe("issue_credit");
    await resolveTenantTools();
    const approvalStep = mark();
    reply(
      calls(call("search-sync", SEARCH_TOOL_NAME, { query: "sync" })),
      text("Credited Bob and found the sync tool."),
    );
    await drive({ inputResponses: [{ optionId: "approve", requestId: approval!.requestId }] });

    // A foreground workflow tool parks the turn and resumes with its result.
    reply(
      calls(call("deploy", CALL_TOOL_NAME, { input: { service: "api" }, name: "deploy_service" })),
    );
    const deploying = await drive({ message: "Alice asks to deploy the api service." });
    expect(
      parkedSteps(deploying.session).flatMap((step) => step.tasks.map((task) => task.toolName)),
    ).toEqual(["deploy_service"]);
    reply(text("Deployed api."));
    await drive({
      runtimeActionResults: [
        {
          callId: "deploy",
          kind: "tool-result",
          output: "deployed api",
          toolName: "deploy_service",
        },
      ],
    });

    // A background workflow tool and a deferred subagent each start a task.
    reply(
      calls(
        call("research", CALL_TOOL_NAME, { input: { topic: "refunds" }, name: "research" }),
        call("delegate", CALL_TOOL_NAME, {
          input: { message: "Review Bob's dispute." },
          name: "billing_specialist",
        }),
      ),
    );
    const delegating = await drive({ message: "Alice asks for research and a dispute review." });
    expect(
      parkedSteps(delegating.session).flatMap((step) => step.tasks.map((task) => task.toolName)),
    ).toEqual(["research", "billing_specialist"]);
    reply(text("Both are underway."));
    await drive({
      runtimeActionResults: [
        {
          callId: "research",
          kind: "tool-result",
          output: "Started task research-1.",
          toolName: "research",
        },
        {
          callId: "delegate",
          kind: "tool-result",
          output: "Started task billing_specialist-1.",
          toolName: "billing_specialist",
        },
      ],
    });

    // A connection tool parks the turn for sign-in, then runs once the user signs in.
    reply(calls(call("items", CALL_TOOL_NAME, { name: "private__list_items" })));
    const signingIn = await drive({ message: "Alice wants the items in the private catalog." });
    const [challenge] = getPendingAuthorization(signingIn.session.state)?.challenges ?? [];
    expect(challenge?.name).toBe("private");
    expect(privateCatalog.signIns).toHaveLength(1);
    // Delivers the callback the way the turn step does when the user signs in.
    ctx.set(PendingAuthorizationResultKey, [
      {
        attemptId: challenge!.attemptId,
        callback: { method: "GET", params: { code: "alice" } },
        hookUrl: challenge!.hookUrl,
        instanceId: challenge!.instanceId,
        name: "private",
      },
    ]);
    driver.session = {
      ...driver.session,
      state: clearPendingAuthorization(driver.session.state, [challenge!.attemptId!]),
    };
    reply(
      calls(call("items-after-sign-in", CALL_TOOL_NAME, { name: "private__list_items" })),
      text("The private catalog has Alice's lamp."),
    );
    await drive();
    expect(privateCatalog.calls).toEqual([{ input: {}, tool: "list_items" }]);

    // A dynamic connection resolves.
    connections.push(
      fakeConnection({
        description: "Caller-specific product catalog.",
        name: "products",
        tools: [connectionTool("get_status")],
      }),
    );
    const connectionStep = mark();
    reply(
      calls(call("status", CALL_TOOL_NAME, { name: "products__get_status" })),
      text("The product catalog is up."),
    );
    await drive({ message: "Alice asks whether the product catalog is up." });

    // A dynamic deferred subagent appears and the dynamic tool disappears.
    await dispatchDynamicSubagentEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [
        {
          eventNames: ["session.started"],
          events: {
            "session.started": () =>
              defineAgent({
                description: "Answer questions about the tenant's plan.",
                model: "openai/gpt-5.5",
                modelContextWindowTokens: 200_000,
                tool: "deferred",
              }),
          },
          kind: "subagent",
          logicalPath: "subagents/plan_advisor/agent.ts",
          name: "plan_advisor",
          nodeId: "subagents/plan_advisor",
          sourceId: "subagents/plan_advisor/agent.ts",
          sourceKind: "module",
        },
      ],
    });
    tenantSyncAvailable = false;
    await resolveTenantTools();
    const changedStep = mark();
    reply(
      calls(call("sync-again", CALL_TOOL_NAME, { name: "tenant__sync" })),
      text("The sync tool is gone."),
    );
    await drive({ message: "Alice asks to sync the tenant again." });
    // An entry the resolver no longer returns can't be called.
    const gone = toolResult(driver.requests().at(-1)!, "sync-again");
    expect(gone).toContain("No tool named");
    expect(gone).toContain("tenant__sync");

    // A tool and a skill share a name; skills load deferred or not, including
    // a dynamic deferred skill that appears when the turn starts. It joins the
    // listed `ops` namespace, so the listing doesn't change.
    await dispatchDynamicSkillEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 9, turnId: "turn_9" }),
      messages: [],
      resolvers: [
        {
          eventNames: ["turn.started"],
          events: {
            "turn.started": () => ({
              ops__playbook: defineSkill({
                deferred: true,
                description: "The ops escalation playbook.",
                markdown: "# Ops playbook",
              }),
            }),
          },
          exportName: "default",
          logicalPath: "skills/playbooks.ts",
          slug: "playbooks",
          sourceId: "skills/playbooks.ts",
          sourceKind: "module",
        },
      ],
    });
    const skillStep = mark();
    reply(
      calls(call("search-notes", SEARCH_TOOL_NAME, { query: "release notes" })),
      calls(
        call("notes", SKILL_TOOL_NAME, { name: "release_notes" }),
        call("forms", SKILL_TOOL_NAME, { name: "pdf-forms" }),
        call("playbook", SKILL_TOOL_NAME, { name: "ops__playbook" }),
        call("rules", SKILL_TOOL_NAME, { name: "house-rules" }),
      ),
      text("Loaded the skills."),
    );
    await drive({ message: "Alice asks how to publish release notes and escalate." });
    expect(toolResult(driver.requests()[skillStep + 1]!, "search-notes")).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ tool: "release_notes" }),
        {
          description: "How to write release notes.",
          path: "$HOME/.agents/skills/release_notes/SKILL.md",
          skill: "release_notes",
        },
      ]),
    });
    const loaded = JSON.stringify(driver.requests().at(-1)!.prompt);
    for (const markdown of ["# release_notes", "# pdf-forms", "# Ops playbook", "# House rules"]) {
      expect(loaded).toContain(markdown);
    }

    const historyBeforeCompaction = driver.session.history;

    // Compaction replaces history; the next request starts a fresh baseline.
    // Any real history exceeds a threshold of 1, so the next step compacts.
    const compactionStep = mark();
    driver.session = {
      ...driver.session,
      compaction: { ...driver.session.compaction, threshold: 1 },
    };
    reply(text("Ready for the next request."));
    await drive({ message: "Alice asks what is next." });

    const requests = driver.requests();
    const listingFor = (index: number) => catalogMessages(requests[index]!);

    // 1. Fixed tools: the same names, descriptions, schemas, and order on every request.
    expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual([
      "add",
      TASK_WAIT_TOOL_NAME,
      TASK_CANCEL_TOOL_NAME,
      SEARCH_TOOL_NAME,
      CALL_TOOL_NAME,
      SKILL_TOOL_NAME,
    ]);
    for (const request of requests) expect(request.tools).toEqual(requests[0]!.tools);

    // 2. No session-specific text in the system prompt or any tool description.
    const fixedText = [
      ...systemText(requests[0]!),
      ...(requests[0]!.tools ?? []).map((tool) => ("description" in tool ? tool.description : "")),
    ].join("\n");
    for (const name of [
      "refund_invoice",
      "deploy_service",
      "billing_specialist",
      "tenant__sync",
      "plan_advisor",
      "pdf-forms",
      "ops__playbook",
      "private",
      "products",
    ]) {
      expect(fixedText).not.toContain(name);
    }
    for (const request of requests) expect(systemText(request)).toEqual(systemText(requests[0]!));

    // 3. Append-only history: each request extends the one before it, until compaction.
    for (let index = 1; index < requests.length; index += 1) {
      if (index === compactionStep) continue;
      const previous = conversation(requests[index - 1]!);
      expect(conversation(requests[index]!).slice(0, previous.length), `request ${index}`).toEqual(
        previous,
      );
    }

    // 4. No system-message fallback, including on the step that runs approved
    // calls: the approved call's result, then the listing, which gained the
    // `tenant` namespace, as an appended message.
    const approvedStep = requests[approvalStep]!;
    expect(toolResult(approvedStep, "credit")).toEqual({ input: {}, ran: "issue_credit" });
    expect(approvedStep.prompt.at(-2)?.role).toBe("tool");
    expect(approvedStep.prompt.at(-1)).toEqual({
      content: [{ text: expect.stringMatching(NAMESPACES_OPS_TENANT), type: "text" }],
      role: "user",
    });
    expect(listingFor(approvalStep).at(-1)).toMatch(/^The catalog changed\./u);
    expect(systemText(approvedStep).join("\n")).not.toContain("tenant");
    expect(listingFor(approvalStep)).toHaveLength(2);

    // 5. Deterministic rendering is owned by listing.test.ts; here each change
    // appends the listing again, and compaction starts a fresh baseline.
    expect(listingFor(0)).toEqual([
      expect.stringContaining("You have more tools, agents, and skills than are loaded here"),
    ]);
    expect(listingFor(connectionStep).at(-1)).toContain(
      "- products: Caller-specific product catalog.",
    );
    expect(listingFor(changedStep).at(-1)).toMatch(/\nNo longer available: tenant$/u);
    expect(listingFor(compactionStep)).toEqual([expect.stringMatching(/^Namespaces, .*: ops$/mu)]);

    // 6. Calling an entry adds nothing: only catalog changes append listing
    // messages. A dynamic agent of a kind already listed, or a skill joining a
    // listed namespace (skillStep), changes nothing the listing says.
    const announcedAt = requests.flatMap((_request, index) =>
      index > 0 && listingFor(index).length > listingFor(index - 1).length ? [index] : [],
    );
    expect(announcedAt).toEqual([approvalStep, connectionStep, changedStep]);

    // The stand-in result for calls the harness dispatches after the step never
    // reaches the model or the protocol: until compaction, each prompt carries
    // exactly one result per call, and it is the dispatched call's real result.
    for (const callId of ["deploy", "research", "delegate"]) {
      const firstResult = requests.findIndex(
        (request) => toolResultParts(request, callId).length > 0,
      );
      expect(firstResult, callId).toBeGreaterThan(0);
      for (const request of requests.slice(firstResult, compactionStep)) {
        expect(
          toolResultParts(request, callId).map((part) => part.output),
          callId,
        ).toEqual([expect.objectContaining({ value: expect.anything() })]);
      }
    }
    for (const callId of ["deploy", "research", "delegate"]) {
      const results = driver.events.filter(
        (event) => event.type === "action.result" && event.data.result.callId === callId,
      );
      expect(results, callId).toHaveLength(1);
      expect(JSON.stringify(results), callId).not.toContain("dispatched");
    }

    // History keeps the model's own catalog calls; actions carry each entry's name.
    const historyCalls = historyBeforeCompaction.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []))
        : [],
    );
    expect(new Set(historyCalls)).toEqual(
      new Set([CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME]),
    );
    expect(
      driver.events.flatMap((event) =>
        event.type === "actions.requested"
          ? event.data.actions.map((action) =>
              action.kind === "load-skill"
                ? `skill:${action.name}`
                : "toolName" in action
                  ? action.toolName
                  : action.name,
            )
          : [],
      ),
    ).toEqual([
      SEARCH_TOOL_NAME,
      "refund_invoice",
      "issue_credit",
      SEARCH_TOOL_NAME,
      "deploy_service",
      "research",
      "billing_specialist",
      // The call that parked for sign-in, then the model's call after it.
      "private__list_items",
      "private__list_items",
      "products__get_status",
      SEARCH_TOOL_NAME,
      "skill:release_notes",
      "skill:pdf-forms",
      "skill:ops__playbook",
      "skill:house-rules",
    ]);
    // A skill load's result is named for the same skill, and its input is the model's own.
    const skillActions = driver.events.flatMap((event) =>
      event.type === "actions.requested"
        ? event.data.actions.filter((action) => action.kind === "load-skill")
        : [],
    );
    expect(skillActions.map(({ input, name }) => ({ input, name }))).toEqual(
      ["release_notes", "pdf-forms", "ops__playbook", "house-rules"].map((name) => ({
        input: { name },
        name,
      })),
    );
    expect(
      driver.events.flatMap((event) =>
        event.type === "action.result" && event.data.result.kind === "load-skill-result"
          ? [event.data.result.name]
          : [],
      ),
    ).toEqual(["release_notes", "pdf-forms", "ops__playbook", "house-rules"]);
  });

  it("runs a listed tool named through eve__tool exactly as a direct call", async () => {
    const ctx = createSessionContext();
    ctx.set(BundleKey, catalogBundle());
    const driver = createDriver(
      ctx,
      toolMap(
        inlineTool("lookup_order", {
          schema: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
        }),
        inlineTool("archive_account", { approval: always() }),
        workflowTool("deploy_service"),
        // eve's built-in tools and static agents are marked as framework tools.
        inlineTool("bash", { frameworkTool: true }),
        subagentTool("billing_specialist", { frameworkTool: true }),
        inlineTool("refund_invoice", { deferred: true }),
      ),
    );

    driver.reply(
      calls(
        call("lookup", CALL_TOOL_NAME, { input: { orderId: "o_1" }, name: "lookup_order" }),
        call("shell", CALL_TOOL_NAME, { name: "bash" }),
      ),
      text("Found order o_1."),
    );
    await driver.drive({ message: "Alice asks about order o_1." });
    expect(toolResult(driver.requests()[1]!, "lookup")).toEqual({
      input: { orderId: "o_1" },
      ran: "lookup_order",
    });
    expect(toolResult(driver.requests()[1]!, "shell")).toEqual({ input: {}, ran: "bash" });
    expect(
      driver.events.flatMap((event) =>
        event.type === "actions.requested" ? event.data.actions : [],
      ),
    ).toContainEqual(
      expect.objectContaining({
        callId: "lookup",
        input: { orderId: "o_1" },
        toolName: "lookup_order",
      }),
    );

    // An approval is asked for, and the call runs, under the listed tool's own name.
    driver.reply(calls(call("archive", CALL_TOOL_NAME, { name: "archive_account" })));
    const parked = await driver.drive({ message: "Alice asks to archive Bob's account." });
    const [approval] = parkedSteps(parked.session).flatMap((step) => step.requests);
    expect(approval?.action).toEqual(
      expect.objectContaining({ callId: "archive", toolName: "archive_account" }),
    );
    driver.reply(text("Archived Bob's account."));
    await driver.drive({
      inputResponses: [{ optionId: "approve", requestId: approval!.requestId }],
    });
    expect(toolResult(driver.requests().at(-1)!, "archive")).toEqual({
      input: {},
      ran: "archive_account",
    });

    // A listed workflow tool and static agent are dispatched after the step, as direct calls are.
    driver.reply(
      calls(
        call("deploy", CALL_TOOL_NAME, { input: { service: "api" }, name: "deploy_service" }),
        call("delegate", CALL_TOOL_NAME, {
          input: { message: "Review Bob's dispute." },
          name: "billing_specialist",
        }),
      ),
    );
    const deploying = await driver.drive({ message: "Alice asks to deploy and review a dispute." });
    expect(
      parkedSteps(deploying.session).flatMap((step) => step.tasks.map((task) => task.toolName)),
    ).toEqual(["deploy_service", "billing_specialist"]);
  });

  it("names the entry, not eve__tool, when a deferred entry returns a result that isn't JSON", async () => {
    const logs = captureLogRecords();
    const ctx = createSessionContext();
    ctx.set(BundleKey, catalogBundle());
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const driver = createDriver(
      ctx,
      toolMap(
        inlineTool("add"),
        inlineTool("export_ledger", { deferred: true, execute: async () => circular }),
      ),
    );
    driver.reply(
      calls(call("export", CALL_TOOL_NAME, { name: "export_ledger" })),
      text("The ledger export failed."),
    );

    await driver.drive({ message: "Alice asks for the ledger export." });

    expect(toolResult(driver.requests()[1]!, "export")).toContain(
      'Tool "export_ledger" call "export" returned a non-JSON-serializable result.',
    );
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ toolCallId: "export", toolName: "export_ledger" }),
        message: "tool execution failed",
      }),
    );
  });

  it("gives an agent with only listed skills eve__skill to load them, no search, and no listing", async () => {
    const ctx = createSessionContext();
    ctx.set(BundleKey, catalogBundle({ skills: [{ name: "house-rules" }] }));
    const driver = createDriver(ctx, toolMap(inlineTool("add")));
    driver.reply(
      calls(call("load-rules", SKILL_TOOL_NAME, { name: "house-rules" })),
      calls(call("add", "add", {})),
      text("Done, following the house rules."),
    );

    await driver.drive({ message: "Alice asks for a sum, following the house rules." });

    const requests = driver.requests();
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["add", SKILL_TOOL_NAME]);
      expect(catalogMessages(request)).toEqual([]);
    }
    expect(toolResult(requests[1]!, "load-rules")).toBe("# house-rules");
  });

  it("validates a connection tool's input before asking anyone to approve the call", async () => {
    const ctx = createSessionContext();
    const crm = fakeConnection({
      approval: always(),
      name: "crm",
      tools: [
        connectionTool("archive_account", {
          type: "object",
          properties: { accountId: { type: "string" } },
          required: ["accountId"],
        }),
      ],
    });
    ctx.set(ConnectionRegistryKey, connectionRegistry([crm]));
    ctx.set(BundleKey, catalogBundle({ connections: [crm.definition] }));
    const driver = createDriver(ctx, toolMap(inlineTool("add")));
    driver.reply(
      calls(call("archive-unnamed", CALL_TOOL_NAME, { input: {}, name: "crm__archive_account" })),
      calls(
        call("archive", CALL_TOOL_NAME, {
          input: { accountId: "acct_1" },
          name: "crm__archive_account",
        }),
      ),
    );

    const parked = await driver.drive({ message: "Alice asks to archive Bob's account." });

    const requests = parkedSteps(parked.session).flatMap((step) => step.requests);
    expect(requests.map((request) => request.action)).toEqual([
      expect.objectContaining({ callId: "archive", toolName: "crm__archive_account" }),
    ]);
    expect(toolResult(driver.requests()[1]!, "archive-unnamed")).toContain(
      "Signature: crm__archive_account(input: { accountId: string })",
    );
    expect(crm.calls).toEqual([]);

    driver.reply(text("Archived Bob's account."));
    await driver.drive({
      inputResponses: [{ optionId: "approve", requestId: requests[0]!.requestId }],
    });
    expect(crm.calls).toEqual([{ input: { accountId: "acct_1" }, tool: "archive_account" }]);
  });
});
