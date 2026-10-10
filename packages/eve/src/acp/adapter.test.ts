import type { AgentContext } from "#compiled/@agentclientprotocol/sdk/index.js";
import { describe, expect, it, vi } from "vitest";

import { EveAcpAdapter } from "#acp/adapter.js";
import type { SendTurnInput, SendTurnPayload } from "#client/types.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const turnId = "turn_0";
const runId = "run_0";
const scope = { runId, turnId };

/** A fake eve session: each send or respond streams its next turn's facts. */
class FakeClientSession {
  readonly cancel = vi.fn(async () => ({ sessionId: "session_test", status: "accepted" }));
  readonly reset = vi.fn(async () => ({ status: "reset" }));
  readonly sends: SendTurnPayload[] = [];
  readonly #turns: SessionEvent[][];

  constructor(turns: SessionEvent[][]) {
    this.#turns = turns;
  }

  async send(message: SendTurnInput["message"]): Promise<AsyncIterable<SessionStreamEvent>> {
    return this.#next({ message });
  }

  async respond(
    inputResponses: NonNullable<SendTurnPayload["inputResponses"]>,
  ): Promise<AsyncIterable<SessionStreamEvent>> {
    return this.#next({ inputResponses });
  }

  #next(input: SendTurnPayload): AsyncIterable<SessionStreamEvent> {
    this.sends.push(input);
    const events = stampTestEvents(this.#turns.shift() ?? []);
    return (async function* () {
      yield* events;
    })();
  }
}

function adapterWith(turns: SessionEvent[][]) {
  const session = new FakeClientSession(turns);
  const adapter = new EveAcpAdapter({
    client: {
      sessions: {
        async create(input: SendTurnInput) {
          return { response: await session.send(input.message), session };
        },
      },
    },
    eveVersion: "1.2.3",
    serverUrl: "http://127.0.0.1:2000",
    workspaceRoot: process.cwd(),
  });
  return { adapter, session };
}

function acpClient(request: AgentContext["request"] = vi.fn(async () => ({}))) {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const notify = vi.fn(async (method: string, params: unknown) => {
    notifications.push({ method, params });
  });
  const client = Object.assign(Object.create(null), { notify, request }) as AgentContext;
  return { client, notifications };
}

const updates = (notifications: Array<{ params: unknown }>) =>
  notifications.map(({ params }) => (params as { update: Record<string, unknown> }).update);

function opening(): SessionEvent[] {
  return [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
    {
      data: { cause: { deliveryId: "d_0" }, follows: null, turnId },
      scope: { turnId },
      type: "turn.started",
    },
    { data: { deliveryId: "d_0", parts: [], turnId }, type: "delivery.consumed" },
    { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
    { data: { modelId: "m", runId }, scope, type: "model.started" },
  ];
}

function closing(delivery = "d_0"): SessionEvent[] {
  return [
    { data: { outcome: "completed", runId }, scope, type: "model.settled" },
    { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
    { data: { deliveryId: delivery, outcome: "handled", turnId }, type: "delivery.settled" },
  ];
}

const textPrompt = (sessionId: string) => ({
  prompt: [{ text: "hello", type: "text" as const }],
  sessionId,
});

describe("EveAcpAdapter", () => {
  it("streams text, reasoning, and a tool call's lifecycle in order", async () => {
    const { adapter } = adapterWith([
      [
        ...opening(),
        {
          data: { delta: "Think", kind: "reasoning", partId: "p_r" },
          scope,
          type: "content.delta",
        },
        { data: { delta: "Hi", kind: "text", partId: "p_t" }, scope, type: "content.delta" },
        {
          data: {
            callId: "call-1",
            capability: { kind: "tool", name: "weather" },
            input: { city: "SF" },
            owner: { runId },
          },
          scope,
          type: "call.requested",
        },
        { data: { callId: "call-1" }, scope: { turnId }, type: "call.started" },
        {
          data: { callId: "call-1", outcome: "completed", output: { condition: "sunny" } },
          scope: { turnId },
          type: "call.settled",
        },
        ...closing(),
      ],
    ]);
    const { sessionId } = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
    const { client, notifications } = acpClient();

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).resolves.toEqual({ stopReason: "end_turn" });

    expect(updates(notifications).map((update) => [update.sessionUpdate, update.status])).toEqual([
      ["agent_thought_chunk", undefined],
      ["agent_message_chunk", undefined],
      ["tool_call", "pending"],
      ["tool_call_update", "completed"],
    ]);
    expect(updates(notifications)[2]).toMatchObject({
      rawInput: { city: "SF" },
      toolCallId: "call-1",
    });
  });

  it("asks the ACP client to approve a call, and answers eve with its choice", async () => {
    const approvalTurn: SessionEvent[] = [
      ...opening(),
      {
        data: {
          callId: "call-1",
          capability: { kind: "tool", name: "deploy" },
          input: {},
          owner: { runId },
        },
        scope,
        type: "call.requested",
      },
      { data: { outcome: "completed", runId }, scope, type: "model.settled" },
      {
        data: {
          interactionId: "approval-1",
          request: {
            display: "confirmation",
            kind: "approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve deploy?",
          },
          subject: { callId: "call-1" },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
      {
        data: { awaiting: [{ interactionId: "approval-1" }], turnId },
        scope: { turnId },
        type: "turn.paused",
      },
      { data: { deliveryId: "d_0", outcome: "awaiting-input", turnId }, type: "delivery.settled" },
    ];
    const resumed: SessionEvent[] = [
      { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
      {
        data: { interactionId: "approval-1", outcome: "accepted" },
        scope: { turnId },
        type: "interaction.settled",
      },
      { data: { cause: { deliveryId: "d_1" }, turnId }, scope: { turnId }, type: "turn.resumed" },
      {
        data: { callId: "call-1", outcome: "completed", output: "done" },
        scope: { turnId },
        type: "call.settled",
      },
      { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
      { data: { deliveryId: "d_1", outcome: "handled", turnId }, type: "delivery.settled" },
    ];
    const { adapter, session } = adapterWith([approvalTurn, resumed]);
    const { sessionId } = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
    const request = vi.fn(async () => ({
      outcome: { optionId: "approval-1:approve", outcome: "selected" },
    }));
    const { client } = acpClient(request);

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).resolves.toEqual({ stopReason: "end_turn" });

    expect(request).toHaveBeenCalledOnce();
    expect(session.sends.at(-1)).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    });
  });

  it("reports a cancelled turn as cancelled", async () => {
    const { adapter } = adapterWith([
      [
        ...opening(),
        { data: { outcome: "interrupted", runId }, scope, type: "model.settled" },
        {
          data: { cause: { deliveryId: "cancel-1" }, outcome: "cancelled", turnId },
          scope: { turnId },
          type: "turn.settled",
        },
        { data: { deliveryId: "d_0", outcome: "handled", turnId }, type: "delivery.settled" },
      ],
    ]);
    const { sessionId } = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
    const { client } = acpClient();

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("fails the prompt with the turn's error, ending its running calls", async () => {
    const { adapter } = adapterWith([
      [
        ...opening(),
        {
          data: {
            callId: "call-1",
            capability: { kind: "tool", name: "slow" },
            input: {},
            owner: { runId },
          },
          scope,
          type: "call.requested",
        },
        { data: { callId: "call-1" }, scope: { turnId }, type: "call.started" },
        {
          data: { error: { code: "BOOM", message: "It broke." }, outcome: "failed", runId },
          scope,
          type: "model.settled",
        },
        {
          data: { error: { code: "BOOM", message: "It broke." }, outcome: "failed", turnId },
          scope: { turnId },
          type: "turn.settled",
        },
        { data: { deliveryId: "d_0", outcome: "handled", turnId }, type: "delivery.settled" },
      ],
    ]);
    const { sessionId } = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
    const { client, notifications } = acpClient();

    await expect(
      adapter.prompt(textPrompt(sessionId), client, new AbortController().signal),
    ).rejects.toThrow(/It broke/);
    expect(updates(notifications).at(-1)).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "failed",
      toolCallId: "call-1",
    });
  });

  it("resets its eve session when the ACP session closes", async () => {
    const { adapter, session } = adapterWith([[...opening(), ...closing()]]);
    const { sessionId } = await adapter.newSession({ cwd: process.cwd(), mcpServers: [] });
    await adapter.prompt(textPrompt(sessionId), acpClient().client, new AbortController().signal);

    await adapter.closeSession(sessionId);
    expect(session.reset).toHaveBeenCalledOnce();
  });
});
