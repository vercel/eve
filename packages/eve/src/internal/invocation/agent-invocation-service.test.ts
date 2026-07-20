import { describe, expect, it, vi } from "vitest";

import {
  AgentInvocationNotFoundError,
  AgentInvocationService,
  type AgentInvocationRepository,
  type AgentInvocationSnapshot,
} from "#internal/invocation/agent-invocation-service.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const alice = auth("alice");
const bob = auth("bob");

class MemoryRepository implements AgentInvocationRepository {
  readonly records = new Map<string, AgentInvocationSnapshot & { key?: string }>();
  creates = 0;

  async create(input: Parameters<AgentInvocationRepository["create"]>[0]) {
    this.creates++;
    const record = {
      createdAt: "2026-07-20T00:00:00.000Z",
      events: [] as HandleMessageStreamEvent[],
      invocationId: `inv_${this.creates}`,
      key: input.idempotencyKeyHash,
      ownerFingerprint: input.ownerFingerprint,
      revision: 0,
    };
    this.records.set(record.invocationId, record);
    return record;
  }
  async findByIdempotencyKey(
    input: Parameters<AgentInvocationRepository["findByIdempotencyKey"]>[0],
  ) {
    return [...this.records.values()].find(
      (record) =>
        record.key === input.idempotencyKeyHash &&
        record.ownerFingerprint === input.ownerFingerprint,
    );
  }
  async read(id: string) {
    return this.records.get(id);
  }
  async update(id: string) {
    const record = this.records.get(id)!;
    this.records.set(id, {
      ...record,
      events: [...record.events, startedEvent()],
      revision: record.revision + 1,
    });
  }
  async cancel(id: string) {
    const record = this.records.get(id)!;
    this.records.set(id, {
      ...record,
      events: [...record.events, cancelledEvent()],
      revision: record.revision + 1,
    });
  }
}

describe("AgentInvocationService", () => {
  it("deduplicates create per caller and survives a service restart", async () => {
    const repository = new MemoryRepository();
    const firstService = new AgentInvocationService(repository);
    const first = await firstService.create({
      auth: alice,
      idempotencyKey: "retry",
      message: "work",
    });
    const restartedService = new AgentInvocationService(repository);
    const retry = await restartedService.create({
      auth: alice,
      idempotencyKey: "retry",
      message: "work",
    });
    const otherCaller = await restartedService.create({
      auth: bob,
      idempotencyKey: "retry",
      message: "work",
    });
    expect(retry.invocationId).toBe(first.invocationId);
    expect(otherCaller.invocationId).not.toBe(first.invocationId);
    expect(repository.creates).toBe(2);
  });

  it("hides invocations from other principals", async () => {
    const repository = new MemoryRepository();
    const service = new AgentInvocationService(repository);
    const invocation = await service.create({ auth: alice, message: "work" });
    await expect(
      service.read({ auth: bob, invocationId: invocation.invocationId }),
    ).rejects.toBeInstanceOf(AgentInvocationNotFoundError);
  });

  it("projects input, completion, failure, and cancellation", async () => {
    const repository = new MemoryRepository();
    const service = new AgentInvocationService(repository);
    const invocation = await service.create({ auth: alice, message: "work" });
    const record = repository.records.get(invocation.invocationId)!;
    repository.records.set(invocation.invocationId, {
      ...record,
      events: [inputEvent()],
      revision: 1,
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

  it("long polls until the revision changes", async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryRepository();
      const service = new AgentInvocationService(repository, { maxWaitMs: 2_000 });
      const invocation = await service.create({ auth: alice, message: "work" });
      const read = service.read({
        auth: alice,
        invocationId: invocation.invocationId,
        afterRevision: 0,
        waitMs: 1_000,
      });
      const record = repository.records.get(invocation.invocationId)!;
      repository.records.set(invocation.invocationId, {
        ...record,
        events: [completedEvent()],
        revision: 1,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(read).resolves.toMatchObject({ revision: 1, status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

function auth(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}
function startedEvent(): HandleMessageStreamEvent {
  return {
    data: { sequence: 1, turnId: "turn" },
    meta: { at: "2026-07-20T00:00:00Z" },
    type: "turn.started",
  };
}
function cancelledEvent(): HandleMessageStreamEvent {
  return {
    data: { sequence: 1, turnId: "turn" },
    meta: { at: "2026-07-20T00:00:00Z" },
    type: "turn.cancelled",
  };
}
function completedEvent(): HandleMessageStreamEvent {
  return { meta: { at: "2026-07-20T00:00:00Z" }, type: "session.completed" };
}
function inputEvent(): HandleMessageStreamEvent {
  return {
    data: {
      requests: [
        {
          action: { callId: "call", input: {}, kind: "tool-call", toolName: "ask_question" },
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Proceed?",
          requestId: "question",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn",
    },
    meta: { at: "2026-07-20T00:00:00Z" },
    type: "input.requested",
  };
}
