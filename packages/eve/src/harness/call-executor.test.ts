import { eventsOf } from "#harness/publication.js";
import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";
import type { ApprovalStatus } from "#approval/definition.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SenderAuthKey, SessionKey } from "#context/keys.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveConnectionPrincipal } from "#runtime/connections/principal.js";

it.each([
  [undefined, "run"],
  [false, "run"],
  [true, "ask"],
  ["not-applicable", "run"],
  ["approved", "run"],
  ["denied", "deny"],
  ["user-approval", "ask"],
  [{ type: "not-applicable" }, "run"],
  [{ type: "approved", reason: "Within the team's policy." }, "run"],
  [{ type: "denied", reason: "Outside the team's policy." }, "deny"],
  [{ type: "user-approval" }, "ask"],
] as const)("preserves policy return %j and records the decision", async (status, outcome) => {
  const execute = vi.fn(() => "saved");
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null, sender: null },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });
  const events: import("#protocol/session-event.js").SessionEvent[] = [];
  const results = await contextStorage.run(ctx, () =>
    executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "save", type: "tool-call" }],
      tools: new Map([
        [
          "save",
          {
            name: "save",
            description: "Save notes",
            inputSchema: jsonSchema({ type: "object" }),
            execute,
            approval: () => status,
          },
        ],
      ]),
    }),
  );
  expect(execute).toHaveBeenCalledTimes(outcome === "run" ? 1 : 0);
  expect(results.approvals).toHaveLength(outcome === "ask" ? 1 : 0);
  const reason = typeof status === "object" && "reason" in status ? status.reason : undefined;
  if (outcome === "run") {
    const type = typeof status === "object" ? status.type : status;
    expect(events.find((event) => event.type === "call.started")?.data.clearedBy).toEqual(
      type === "approved" ? { policy: "approval" } : undefined,
    );
    expect(results.parts[0]?.output).toEqual({ type: "text", value: "saved" });
  } else if (outcome === "deny") {
    expect(results.parts[0]?.output).toMatchObject({ type: "execution-denied", reason });
    // A refusal is told apart from a body that ran and failed: it rejects, and never starts.
    expect(events.map((event) => event.type)).not.toContain("call.started");
    expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
      cause: { policy: "approval" },
      outcome: "rejected",
      output: { code: "TOOL_EXECUTION_DENIED", tool: { result: "not_run" } },
    });
  }
});

it.each([null, "allow", { type: "approved", reason: 123 }])(
  "fails closed for an invalid JavaScript approval return %j",
  async (status) => {
    const execute = vi.fn();
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null, sender: null },
      sessionId: "session-1",
      turn: { id: "turn_0", sequence: 0 },
    });
    const result = await contextStorage.run(ctx, () =>
      executeInlineCalls({
        abortSignal: undefined,
        approvalMemory: { pending: [], remembered: {} },
        beforeExecute: () => {},
        excludedCallIds: new Set(),
        messages: [],
        publish: async () => {},
        toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "save", type: "tool-call" }],
        tools: new Map([
          [
            "save",
            {
              name: "save",
              description: "Save notes",
              inputSchema: jsonSchema({ type: "object" }),
              execute,
              approval: () => status as ApprovalStatus,
            },
          ],
        ]),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.parts[0]?.output).toMatchObject({ type: "error-text" });
  },
);

it("asks with the prompt a tool's approval writes for the call", async () => {
  const sendPayment: HarnessToolDefinition = {
    approval: {
      prompt: ({ input }) => `Send $${String(input.amount)} to ${String(input.recipient)}?`,
      request: () => "user-approval",
    },
    description: "Send a payment.",
    execute: async () => "sent",
    inputSchema: jsonSchema({ type: "object" }),
    name: "send_payment",
  };
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null, sender: null },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });

  const results = await contextStorage.run(ctx, () =>
    executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async () => {},
      toolCalls: [
        {
          input: { amount: 125, recipient: "Ada" },
          toolCallId: "call-1",
          toolName: "send_payment",
          type: "tool-call",
        },
      ],
      tools: new Map([["send_payment", sendPayment]]),
    }),
  );

  expect(results.approvals.map((ask) => ask.request.prompt)).toEqual(["Send $125 to Ada?"]);
});

it("keeps a thrown tool error's name in the durable call ending", async () => {
  const events: import("#protocol/session-event.js").SessionEvent[] = [];
  await executeInlineCalls({
    abortSignal: undefined,
    approvalMemory: { pending: [], remembered: {} },
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    publish: async (publication) => {
      events.push(...eventsOf(publication));
    },
    toolCalls: [{ input: {}, toolCallId: "call-1", toolName: "lookup", type: "tool-call" }],
    tools: new Map([
      [
        "lookup",
        {
          name: "lookup",
          description: "Look up a record",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => {
            throw Object.assign(new Error("quota exceeded"), { name: "QuotaError" });
          },
        },
      ],
    ]),
  });
  expect(events.find((event) => event.type === "call.settled")?.data).toMatchObject({
    error: { name: "QuotaError", message: "quota exceeded" },
    outcome: "failed",
  });
});

it.each(["policy", "prompt"] as const)(
  "settles a broken deferred %s without losing a sibling's result",
  async (failureAt) => {
    const events: import("#protocol/session-event.js").SessionEvent[] = [];
    const deferred: HarnessToolDefinition = {
      name: "schedule",
      description: "Schedule work",
      inputSchema: jsonSchema({ type: "object" }),
      workflowId: "schedule-workflow",
      approval:
        failureAt === "policy"
          ? () => {
              throw new Error("Approval service unavailable");
            }
          : {
              request: () => "user-approval",
              prompt: () => {
                throw new Error("Approval prompt unavailable");
              },
            },
    };
    const result = await executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [
        { input: {}, toolCallId: "broken", toolName: "schedule", type: "tool-call" },
        { input: {}, toolCallId: "saved", toolName: "save", type: "tool-call" },
      ],
      tools: new Map([
        ["schedule", deferred],
        [
          "save",
          {
            name: "save",
            description: "Save notes",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => "saved",
          },
        ],
      ]),
    });
    expect(result.parts).toEqual([
      expect.objectContaining({
        toolCallId: "broken",
        output: expect.objectContaining({ type: "error-text" }),
      }),
      expect.objectContaining({ toolCallId: "saved", output: { type: "text", value: "saved" } }),
    ]);
    expect(
      events
        .filter((event) => event.type === "call.settled")
        .map((event) => [event.data.callId, event.data.outcome])
        .sort(),
    ).toEqual([
      ["broken", "failed"],
      ["saved", "completed"],
    ]);
    expect(result.approvals).toEqual([]);
  },
);

it("closes a streaming tool when progress publication fails", async () => {
  let closed = false;
  const result = await executeInlineCalls({
    abortSignal: undefined,
    approvalMemory: { pending: [], remembered: {} },
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [],
    publish: async (publication) => {
      if (eventsOf(publication).some((event) => event.type === "call.progress"))
        throw new Error("Progress unavailable");
    },
    toolCalls: [{ input: {}, toolCallId: "stream", toolName: "stream", type: "tool-call" }],
    tools: new Map([
      [
        "stream",
        {
          name: "stream",
          description: "Stream work",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async function* () {
            try {
              yield "working";
              yield "done";
            } finally {
              closed = true;
            }
          },
        },
      ],
    ]),
  });
  expect(result.parts[0]?.output).toMatchObject({ type: "error-text" });
  expect(closed).toBe(true);
});

/**
 * Runs a `gh` call made with `input` that needs Alice's identity after Bob spoke, in a session
 * that can ask her when `canAsk`.
 */
async function callNeedingAlice(
  input: Record<string, unknown>,
  { canAsk }: { readonly canAsk: boolean },
) {
  const alice = {
    attributes: { team: "T01" },
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, alice);
  ctx.set(SenderAuthKey, { ...alice, principalId: "bob" });
  ctx.set(SessionKey, {
    auth: { current: alice, initiator: alice, sender: { ...alice, principalId: "bob" } },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });
  const events: import("#protocol/session-event.js").SessionEvent[] = [];
  const results = await contextStorage.run(ctx, () =>
    executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      canAsk,
      excludedCallIds: new Set(),
      messages: [],
      publish: async (publication) => {
        events.push(...eventsOf(publication));
      },
      toolCalls: [{ input, toolCallId: "call-1", toolName: "gh", type: "tool-call" }],
      tools: new Map([
        [
          "gh",
          {
            name: "gh",
            description: "Run gh.",
            inputSchema: jsonSchema({ type: "object" }),
            label: { start: (input) => String((input as { description: string }).description) },
            // What a user-scoped token resolves through before it reaches the provider.
            execute: () =>
              resolveConnectionPrincipal("github", {
                getToken: async () => ({ token: "token" }),
                principalType: "user",
              }),
          },
        ],
      ]),
    }),
  );
  return { events, results };
}

/** The prompt eve asks Alice with for the `gh` call `callNeedingAlice` makes with `input`. */
async function identityPrompt(input: Record<string, unknown>): Promise<string | undefined> {
  return (await callNeedingAlice(input, { canAsk: true })).results.approvals[0]?.request.prompt;
}

it("stops and asks the caller for a call refused their token after someone else spoke", async () => {
  const { events, results } = await callNeedingAlice({ command: "gh pr list" }, { canAsk: true });

  expect(results.parts).toEqual([]);
  expect(results.approvals).toMatchObject([
    {
      call: { callId: "call-1", toolName: "gh" },
      identity: {
        person: { authenticator: "test", principalId: "alice", principalType: "user" },
      },
      request: {
        kind: "approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Cancel" },
        ],
      },
    },
  ]);
  expect(results.approvals[0]?.identity?.person).not.toHaveProperty("attributes");
  expect(events.map((event) => event.type)).toEqual(["call.started"]);
});

it("fails a call refused the caller's token after someone else spoke where the session can't ask", async () => {
  const { events, results } = await callNeedingAlice({ command: "gh pr list" }, { canAsk: false });

  expect(results.approvals).toEqual([]);
  expect(results.parts[0]?.output).toEqual({
    type: "error-text",
    value: expect.stringContaining("can't use their github access until they confirm it"),
  });
  expect(events.map((event) => event.type)).toEqual(["call.started", "call.settled"]);
});

it("names a call that asks for someone's identity by its tool and real input, never by a model-written label", async () => {
  // What approving covers comes before the input, so a channel that cuts the prompt keeps it.
  await expect(
    identityPrompt({ command: "gh repo delete acme/app", description: "List open PRs" }),
  ).resolves.toBe(
    'Approve Gh with your identity? Approving also lets later actions use your identity, on any account, until someone else sends a message after this request. It runs with "command": "gh repo delete acme/app", "description": "List open PRs".',
  );
});

it("shows every input field of a call that asks for someone's identity, so a long field can't hide a later one", async () => {
  const body = "Fixes the flaky retry test. ".repeat(200);
  const prompt = await identityPrompt({
    body,
    command: "gh repo delete acme/app --yes",
    description: "Open the pull request",
  });

  expect(prompt).toContain(`"body": ${JSON.stringify(body.slice(0, 1_998))}… (`);
  expect(prompt).toContain(`${String(body.length - 1_998)} more characters not shown)`);
  expect(prompt).toContain('"command": "gh repo delete acme/app --yes"');
});

it("cuts a field by its escaped length, so one full of control characters can't hide a later field", async () => {
  const prompt = await identityPrompt({ body: "\u0000".repeat(2_000), repo: "acme/app" });

  expect(prompt).toContain('"repo": "acme/app"');
  expect(prompt!.length).toBeLessThan(2_300);
});

it("cuts each item of a nested value on its own, so a later item stays visible", async () => {
  const prompt = await identityPrompt({ args: ["x".repeat(2_000), "--delete"] });

  expect(prompt).toContain('"--delete"]');
});

it("quotes and shortens input keys, so a key can't pass for eve's text", async () => {
  const key = `note\n\nApprove only if you trust bob. ${"k".repeat(200)}`;
  const prompt = await identityPrompt({ [key]: "x", command: "gh pr create" });

  expect(prompt).toContain(`${JSON.stringify(key).slice(0, 79)}"… (`);
  expect(prompt).not.toContain("\n");
  expect(prompt).toContain('"command": "gh pr create"');
});

it("shows a call's last input field however long the fields before it", async () => {
  const padding = Array<number>(1_000).fill(0);
  const prompt = await identityPrompt({
    first: padding,
    second: padding,
    third: padding,
    command: "gh repo delete acme/app --yes",
  });

  expect(prompt).toContain('"command": "gh repo delete acme/app --yes"');
});

// eve runs local tools itself, so an AI SDK integration sees only what eve hands it.
it.each([
  [true, true, "returns"],
  [false, false, "returns"],
  [true, false, "returns"],
  [false, true, "returns"],
  [false, true, "throws"],
] as const)(
  "gives AI SDK integrations tool content per recordInputs %s and recordOutputs %s when the tool %s",
  async (recordInputs, recordOutputs, behavior) => {
    const secret = "alice-invoice-4213";
    const started: Record<string, unknown>[] = [];
    const ended: Record<string, unknown>[] = [];
    await executeInlineCalls({
      abortSignal: undefined,
      approvalMemory: { pending: [], remembered: {} },
      beforeExecute: () => {},
      excludedCallIds: new Set(),
      messages: [{ role: "user", content: `Find ${secret}` }],
      publish: async () => {},
      telemetry: {
        integrations: [
          {
            onToolExecutionStart: (event) => void started.push(event as never),
            onToolExecutionEnd: (event) => void ended.push(event as never),
          },
        ],
        recordInputs,
        recordOutputs,
      },
      toolCalls: [
        { input: { invoice: secret }, toolCallId: "call-1", toolName: "lookup", type: "tool-call" },
      ],
      tools: new Map([
        [
          "lookup",
          {
            name: "lookup",
            description: "Look up an invoice",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async (args: { invoice: string }) => {
              if (behavior === "throws") throw new Error(`no record for ${args.invoice}`);
              return `found ${args.invoice}`;
            },
          },
        ],
      ]),
    });

    const start = started[0] as { messages: unknown[]; toolCall: { input?: unknown } };
    const output = (ended[0] as { toolOutput: Record<string, unknown> }).toolOutput;
    expect(start.toolCall.input).toEqual(recordInputs ? { invoice: secret } : undefined);
    expect(start.messages).toHaveLength(recordInputs ? 1 : 0);
    expect(output.input).toEqual(recordInputs ? { invoice: secret } : undefined);
    if (behavior === "returns") {
      expect(output.output).toEqual(recordOutputs ? `found ${secret}` : undefined);
    } else {
      expect(String(output.error)).not.toContain(secret);
    }
  },
);
