import { describe, expect, it } from "vitest";

import {
  AgentInvocationService,
  type AgentInvocation,
  type AgentInvocationExecution,
  type AgentInvocationMutationResult,
} from "#internal/invocation/agent-invocation-service.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";

const alice = auth("alice");

class MemoryExecution implements AgentInvocationExecution {
  readonly records = new Map<string, AgentInvocation>();
  creates = 0;

  async create(
    _input: Parameters<AgentInvocationExecution["create"]>[0],
  ): Promise<AgentInvocation> {
    this.creates++;
    const invocation = {
      invocationId: `inv_${this.creates}`,
      status: "working" as const,
      createdAt: "2026-07-20T00:00:00.000Z",
      pollAfterMs: 1_000,
    };
    this.records.set(invocation.invocationId, invocation);
    return invocation;
  }

  async read(input: {
    invocationId: string;
    auth: SessionAuthContext;
  }): Promise<AgentInvocation | undefined> {
    return this.records.get(input.invocationId);
  }

  async update(input: {
    invocationId: string;
    auth: SessionAuthContext;
    responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = this.records.get(input.invocationId);
    if (!current) return { type: "not_found" };

    if (current.status !== "input_required") {
      return {
        type: "conflict",
        message: `Invocation is ${current.status}, not waiting for input`,
      };
    }

    // Simulate successful update
    const updated = {
      ...current,
      status: "working" as const,
      inputRequests: undefined,
    };
    this.records.set(input.invocationId, updated);
    return { type: "success", invocation: updated };
  }

  async cancel(input: {
    invocationId: string;
    auth: SessionAuthContext;
  }): Promise<AgentInvocation | undefined> {
    const current = this.records.get(input.invocationId);
    if (!current) return undefined;

    const cancelled = {
      ...current,
      status: "cancelled" as const,
      pollAfterMs: undefined,
    };
    this.records.set(input.invocationId, cancelled);
    return cancelled;
  }

  // Test helpers
  setInvocationState(invocationId: string, state: Partial<AgentInvocation>) {
    const current = this.records.get(invocationId);
    if (current) {
      const updated = { ...current, ...state };
      this.records.set(invocationId, updated);
    }
  }
}

describe("AgentInvocationService", () => {
  it("creates new invocations without idempotency", async () => {
    const execution = new MemoryExecution();
    const service = new AgentInvocationService(execution);
    const first = await service.create({
      auth: alice,
      message: "work",
    });
    const second = await service.create({
      auth: alice,
      message: "work",
    });
    expect(second.invocationId).not.toBe(first.invocationId);
    expect(execution.creates).toBe(2);
  });

  it("handles input requests, updates, and cancellation", async () => {
    const execution = new MemoryExecution();
    const service = new AgentInvocationService(execution);
    const invocation = await service.create({ auth: alice, message: "work" });

    // Simulate input required state
    execution.setInvocationState(invocation.invocationId, {
      status: "input_required",
      inputRequests: {
        question: {
          requestId: "question",
          kind: "question",
          prompt: "Proceed?",
          options: [{ id: "yes", label: "Yes" }],
          action: { kind: "tool-call", toolName: "ask_question", callId: "call1", input: {} },
        },
      },
    });

    expect(
      await service.read({ auth: alice, invocationId: invocation.invocationId }),
    ).toMatchObject({
      status: "input_required",
      inputRequests: { question: { prompt: "Proceed?" } },
    });

    await service.update({
      auth: alice,
      invocationId: invocation.invocationId,
      responses: [{ optionId: "yes", requestId: "question" }],
    });

    await service.cancel({ auth: alice, invocationId: invocation.invocationId });
    expect(
      await service.read({ auth: alice, invocationId: invocation.invocationId }),
    ).toMatchObject({ status: "cancelled" });
  });
});

function auth(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}
