import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import {
  AuthKey,
  DynamicSkillManifestKey,
  SessionDynamicToolMetadataKey,
  SessionIdKey,
  SessionKey,
  StaticModelReferenceKey,
} from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { mockModel, type MockModelResponse, type MockModelToolCall } from "#evals/mock-model.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
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
import { createSessionStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineAgent } from "#public/definitions/agent.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { always } from "#tools/approval/policies.js";
import { registerDurableDynamicCallback } from "#tools/durable-callbacks.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const SESSION_ID = "catalog-session";
const LISTING_HEADER = "More tools and skills are available than your context shows.";

function call(id: string, name: string, input: unknown): MockModelToolCall {
  return { id, input, name };
}

const text = (value: string): MockModelResponse => ({ text: value });
const calls = (...toolCalls: MockModelToolCall[]): MockModelResponse => ({ toolCalls });

/** A model that plays scripted replies in order and keeps every request it receives. */
function scriptedModel() {
  const replies: MockModelResponse[] = [];
  const model = mockModel({
    modelId: "catalog-model",
    respond: () => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("The model script ran out of replies.");
      return reply;
    },
  }) as MockLanguageModelV3;
  return {
    model,
    reply: (...next: MockModelResponse[]) => replies.push(...next),
    requests: () => model.doStreamCalls,
  };
}

function createSessionContext(): ContextContainer {
  const responder = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, responder);
  ctx.set(SessionIdKey, SESSION_ID);
  ctx.set(SessionKey, {
    auth: { current: responder, initiator: null },
    sessionId: SESSION_ID,
    turn: { id: "turn-1", sequence: 1 },
  });
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  ctx.set(StaticModelReferenceKey, { id: "catalog-model" });
  return ctx;
}

/** One session on one harness; `drive` runs a step and every continuation it asks for. */
function createDriver(ctx: ContextContainer, tools: HarnessToolMap) {
  const main = scriptedModel();
  const summary = mockModel("Alice and Bob handled refunds, credits, deploys, and lookups.");
  const events: UnstampedMessageStreamEvent[] = [];
  const harness = createToolLoopHarness({
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async (reference) => (reference.id === "summary" ? summary : main.model),
    tools,
  });
  const driver = {
    events,
    main,
    session: {
      agent: {
        compactionModelReference: { id: "summary" },
        modelReference: { id: "catalog-model" },
        system: "Help Alice run the billing desk.",
        tools: [],
      },
      compaction: { recentWindowSize: 2, threshold: 1_000_000 },
      continuationToken: `http:${SESSION_ID}`,
      history: [],
      sessionId: SESSION_ID,
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
function messageKey(message: LanguageModelV3Prompt[number]): string {
  return JSON.stringify({ content: message.content, role: message.role });
}

function messageText(message: LanguageModelV3Prompt[number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => ("text" in part ? part.text : JSON.stringify(part)))
    .join("\n");
}

const systemText = (request: LanguageModelV3CallOptions) =>
  request.prompt.filter((message) => message.role === "system").map(messageText);
const conversation = (request: LanguageModelV3CallOptions) =>
  request.prompt.filter((message) => message.role !== "system").map(messageKey);

/** The catalog listing and diffs a request carries, in order. */
function catalogMessages(request: LanguageModelV3CallOptions): string[] {
  return request.prompt
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter((entry) => entry.startsWith(LISTING_HEADER) || entry.startsWith("The catalog changed"));
}

function expectPrefix(earlier: readonly string[], later: readonly string[], label: string) {
  expect(later.slice(0, earlier.length), label).toEqual(earlier);
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
      workflowTool("deploy_service", "execute", { deferred: true }),
      workflowTool("research", "task", { deferred: true }),
      subagentTool("billing_specialist", { deferred: true }),
    );
    const driver = createDriver(ctx, tools);
    const { drive, main } = driver;
    const mark = () => main.requests().length;

    // A search, then an inline tool through execute.
    main.reply(
      calls(call("search-refund", "search", { query: "refund" })),
      calls(call("refund", "execute", { input: { invoiceId: "in_1" }, tool: "refund_invoice" })),
      text("Refunded in_1."),
    );
    await drive({ message: "Alice asks for a refund of invoice in_1." });

    // An approval, during which a dynamic deferred tool appears. The approval
    // response must stay the last message, so its step announces nothing.
    main.reply(calls(call("credit", "execute", { tool: "issue_credit" })));
    const awaitingApproval = await drive({ message: "Alice asks for a credit for Bob." });
    const [approval] = getPendingInputBatches(awaitingApproval.session.state).flatMap(
      (batch) => batch.requests,
    );
    expect(approval?.action.toolName).toBe("issue_credit");
    registerDurableDynamicCallback({
      callback: () => ({ synced: true }),
      owner: {
        entryKey: "tenant__sync",
        name: "tenant__sync",
        resolverSlug: "tenant",
        scope: "session",
        sessionId: SESSION_ID,
      },
      phase: "execute",
    });
    ctx.set(SessionDynamicToolMetadataKey, [
      {
        callbacks: { execute: { closure: {} } },
        deferred: true,
        description: "Sync the tenant.",
        entryKey: "tenant__sync",
        inputSchema: { type: "object" },
        name: "tenant__sync",
        resolverSlug: "tenant",
      },
    ]);
    const approvalStep = mark();
    main.reply(
      calls(call("search-sync", "search", { query: "sync" })),
      text("Credited Bob and found the sync tool."),
    );
    await drive({ inputResponses: [{ optionId: "approve", requestId: approval!.requestId }] });

    // A foreground workflow tool parks the turn and resumes with its result.
    main.reply(
      calls(call("deploy", "execute", { input: { service: "api" }, tool: "deploy_service" })),
    );
    const deploying = await drive({ message: "Alice asks to deploy the api service." });
    expect(
      getPendingCoordinationBatch(deploying.session.state)?.tasks.map((task) => task.toolName),
    ).toEqual(["deploy_service"]);
    main.reply(text("Deployed api."));
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
    main.reply(
      calls(
        call("research", "execute", { input: { topic: "refunds" }, tool: "research" }),
        call("delegate", "execute", {
          input: { message: "Review Bob's dispute." },
          tool: "billing_specialist",
        }),
      ),
    );
    const delegating = await drive({ message: "Alice asks for research and a dispute review." });
    expect(
      getPendingCoordinationBatch(delegating.session.state)?.tasks.map((task) => task.toolName),
    ).toEqual(["research", "billing_specialist"]);
    main.reply(text("Both are underway."));
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
    main.reply(calls(call("items", "execute", { tool: "private__list_items" })));
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
    main.reply(
      calls(call("items-after-sign-in", "execute", { tool: "private__list_items" })),
      text("The private catalog has Alice's lamp."),
    );
    await drive();
    expect(privateCatalog.calls).toEqual([{ input: {}, tool: "list_items" }]);

    // A dynamic connection resolves.
    connections.push(
      fakeConnection({
        description: "Caller-specific product catalog.",
        name: "catalog",
        tools: [connectionTool("get_status")],
      }),
    );
    const connectionStep = mark();
    main.reply(
      calls(call("status", "execute", { tool: "catalog__get_status" })),
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
    ctx.set(SessionDynamicToolMetadataKey, []);
    const changedStep = mark();
    main.reply(
      calls(call("sync-again", "execute", { tool: "tenant__sync" })),
      text("The sync tool is gone."),
    );
    await drive({ message: "Alice asks to sync the tenant again." });
    // An entry the resolver no longer returns can't be called.
    expect(JSON.stringify(main.requests().at(-1)!.prompt)).toContain("No tool named");

    // A tool and a skill share a name; skills load deferred or not, including
    // a dynamic deferred skill that appears when the turn starts.
    ctx.set(DynamicSkillManifestKey, {
      playbooks: [
        {
          deferred: true,
          description: "The tenant's escalation playbook.",
          markdown: "# Tenant playbook",
          name: "tenant-playbook",
        },
      ],
    });
    const skillStep = mark();
    main.reply(
      calls(call("search-notes", "search", { query: "release notes" })),
      calls(
        call("notes", "execute", { skill: "release_notes" }),
        call("forms", "execute", { skill: "pdf-forms" }),
        call("playbook", "execute", { skill: "tenant-playbook" }),
        call("rules", "execute", { skill: "house-rules" }),
      ),
      text("Loaded the skills."),
    );
    await drive({ message: "Alice asks how to publish release notes and escalate." });
    const loaded = JSON.stringify(main.requests().at(-1)!.prompt);
    expect(JSON.stringify(main.requests()[skillStep + 1]!.prompt)).toContain(
      '{"description":"How to write release notes.","path":"$HOME/.agents/skills/release_notes/SKILL.md","skill":"release_notes"}',
    );
    expect(JSON.stringify(main.requests()[skillStep + 1]!.prompt)).toContain(
      '"tool":"release_notes"',
    );
    for (const markdown of [
      "# release_notes",
      "# pdf-forms",
      "# Tenant playbook",
      "# House rules",
    ]) {
      expect(loaded).toContain(markdown);
    }

    const historyBeforeCompaction = driver.session.history;

    // Compaction replaces history; the next request starts a fresh baseline.
    const compactionStep = mark();
    driver.session = {
      ...driver.session,
      compaction: { ...driver.session.compaction, threshold: 500 },
    };
    main.reply(text("Ready for the next request."));
    await drive({ message: "Alice asks what is next." });

    const requests = main.requests();
    const listingFor = (index: number) => catalogMessages(requests[index]!);

    // 1. Fixed tools: the same names, descriptions, schemas, and order on every request.
    expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual([
      "add",
      "task_wait",
      "task_cancel",
      "search",
      "execute",
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
      "tenant-playbook",
      "private",
      "catalog",
    ]) {
      expect(fixedText).not.toContain(name);
    }
    for (const request of requests) expect(systemText(request)).toEqual(systemText(requests[0]!));

    // 3. Append-only history: each request extends the one before it, until compaction.
    for (let index = 1; index < requests.length; index += 1) {
      if (index === compactionStep) continue;
      expectPrefix(
        conversation(requests[index - 1]!),
        conversation(requests[index]!),
        `request ${index}`,
      );
    }

    // 4. No system-message fallback: the dynamic tool that appeared during the
    // approval is announced on the step after the approval response.
    expect(listingFor(approvalStep)).toHaveLength(1);
    expect(listingFor(approvalStep + 1).at(-1)).toBe(
      "The catalog changed.\nTools added: tenant__sync",
    );

    // 5. Deterministic rendering: the baseline is sorted, and later changes are diffs.
    expect(listingFor(0)).toEqual([
      [
        `${LISTING_HEADER} Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).`,
        "Tools: deploy_service, issue_credit, refund_invoice, release_notes, research",
        "Agents: billing_specialist",
        "Skills: pdf-forms, release_notes",
        "Connections:",
        "- private: Private catalog that needs sign-in.",
      ].join("\n"),
    ]);
    expect(listingFor(connectionStep).at(-1)).toBe(
      "The catalog changed.\nConnections added or updated:\n- catalog: Caller-specific product catalog.",
    );
    expect(listingFor(changedStep).at(-1)).toBe(
      "The catalog changed.\nAgents added: plan_advisor\nNo longer available, do not call or load: tenant__sync",
    );
    expect(listingFor(skillStep).at(-1)).toBe(
      "The catalog changed.\nSkills added: tenant-playbook",
    );
    expect(listingFor(compactionStep)).toEqual([
      [
        `${LISTING_HEADER} Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).`,
        "Tools: deploy_service, issue_credit, refund_invoice, release_notes, research",
        "Agents: billing_specialist, plan_advisor",
        "Skills: pdf-forms, release_notes, tenant-playbook",
        "Connections:",
        "- catalog: Caller-specific product catalog.",
        "- private: Private catalog that needs sign-in.",
      ].join("\n"),
    ]);

    // 6. Calling an entry adds nothing: only catalog changes append listing messages.
    const announcedAt = requests.flatMap((_request, index) =>
      index > 0 && listingFor(index).length > listingFor(index - 1).length ? [index] : [],
    );
    expect(announcedAt).toEqual([approvalStep + 1, connectionStep, changedStep, skillStep]);

    // History keeps the model's own execute calls; actions carry each entry's name.
    const historyCalls = historyBeforeCompaction.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []))
        : [],
    );
    expect(new Set(historyCalls)).toEqual(new Set(["execute", "search"]));
    expect(
      driver.events.flatMap((event) =>
        event.type === "actions.requested"
          ? event.data.actions.map((action) =>
              "toolName" in action ? action.toolName : action.kind,
            )
          : [],
      ),
    ).toEqual([
      "search",
      "refund_invoice",
      "issue_credit",
      "search",
      "deploy_service",
      "research",
      "billing_specialist",
      // The call that parked for sign-in, then the model's call after it.
      "private__list_items",
      "private__list_items",
      "catalog__get_status",
      "search",
      "load-skill",
      "load-skill",
      "load-skill",
      "load-skill",
    ]);
  });

  it("gives an agent with an empty catalog both tools and no listing", async () => {
    const ctx = createSessionContext();
    ctx.set(BundleKey, catalogBundle({ skills: [{ name: "house-rules" }] }));
    const driver = createDriver(ctx, toolMap(inlineTool("add")));
    driver.main.reply(
      calls(call("search-empty", "search", { query: "refund" })),
      calls(call("add", "add", {})),
      text("Nothing else is available."),
    );

    await driver.drive({ message: "Alice asks what else the desk can do." });

    const requests = driver.main.requests();
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["add", "search", "execute"]);
      expect(catalogMessages(request)).toEqual([]);
    }
    expect(JSON.stringify(requests[1]!.prompt)).toContain('{"results":[],"total":0}');
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
    ctx.set(BundleKey, catalogBundle());
    const driver = createDriver(ctx, toolMap(inlineTool("add")));
    driver.main.reply(
      calls(call("archive-unnamed", "execute", { input: {}, tool: "crm__archive_account" })),
      calls(
        call("archive", "execute", {
          input: { accountId: "acct_1" },
          tool: "crm__archive_account",
        }),
      ),
    );

    const parked = await driver.drive({ message: "Alice asks to archive Bob's account." });

    const requests = getPendingInputBatches(parked.session.state).flatMap(
      (batch) => batch.requests,
    );
    expect(requests.map((request) => request.action)).toEqual([
      expect.objectContaining({ callId: "archive", toolName: "crm__archive_account" }),
    ]);
    expect(JSON.stringify(driver.main.requests()[1]!.prompt)).toContain("accountId");
    expect(crm.calls).toEqual([]);

    driver.main.reply(text("Archived Bob's account."));
    await driver.drive({
      inputResponses: [{ optionId: "approve", requestId: requests[0]!.requestId }],
    });
    expect(crm.calls).toEqual([{ input: { accountId: "acct_1" }, tool: "archive_account" }]);
  });
});
