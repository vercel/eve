import type { Agent } from "#public/definitions/channel.js";
import type {
  AgentInvocationRepository,
  AgentInvocationSnapshot,
} from "#internal/invocation/agent-invocation-service.js";
import { getWorld } from "#internal/workflow/runtime.js";

const INVOCATION_ATTRIBUTE = "$eve.invocation";
const OWNER_ATTRIBUTE = "$eve.invocation_owner";
const IDEMPOTENCY_ATTRIBUTE = "$eve.invocation_idempotency";
const TOKEN_ATTRIBUTE = "$eve.invocation_token";

/** Workflow-backed invocation repository; the session run is the durable record. */
export class WorkflowAgentInvocationRepository implements AgentInvocationRepository {
  readonly #agent: Agent;
  readonly #channelName: string;

  constructor(agent: Agent, channelName: string) {
    this.#agent = agent;
    this.#channelName = channelName;
  }

  async create(
    input: Parameters<AgentInvocationRepository["create"]>[0],
  ): Promise<AgentInvocationSnapshot> {
    const continuationToken = `invocation:${crypto.randomUUID()}`;
    const handle = await this.#agent.run({
      adapter: { kind: "http" },
      auth: input.auth,
      capabilities: { requestInput: true },
      channelName: this.#channelName,
      continuationToken: `${this.#channelName}:${continuationToken}`,
      input: { message: input.message, outputSchema: input.outputSchema },
      invocationControl: {
        continuationToken,
        idempotencyKeyHash: input.idempotencyKeyHash,
        ownerFingerprint: input.ownerFingerprint,
      },
      mode: "task",
    });
    return {
      createdAt: new Date().toISOString(),
      events: [],
      invocationId: handle.sessionId,
      ownerFingerprint: input.ownerFingerprint,
      revision: 0,
    };
  }

  async findByIdempotencyKey(
    input: Parameters<AgentInvocationRepository["findByIdempotencyKey"]>[0],
  ): Promise<AgentInvocationSnapshot | undefined> {
    const world = await getWorld();
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        pagination: { cursor, limit: 100, sortOrder: "desc" },
        resolveData: "none",
      });
      const run = page.data.find(
        (candidate) =>
          candidate.attributes[INVOCATION_ATTRIBUTE] === "agent" &&
          candidate.attributes[OWNER_ATTRIBUTE] === input.ownerFingerprint &&
          candidate.attributes[IDEMPOTENCY_ATTRIBUTE] === input.idempotencyKeyHash,
      );
      if (run !== undefined) return await this.read(run.runId);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return undefined;
  }

  async read(invocationId: string): Promise<AgentInvocationSnapshot | undefined> {
    const world = await getWorld();
    let run;
    try {
      run = await world.runs.get(invocationId, { resolveData: "none" });
    } catch {
      return undefined;
    }
    if (run.attributes[INVOCATION_ATTRIBUTE] !== "agent") return undefined;

    if (this.#agent.getEventSnapshot === undefined) {
      throw new Error("Agent runtime does not support event snapshots.");
    }
    const events = await this.#agent.getEventSnapshot(invocationId);
    return {
      createdAt: run.createdAt.toISOString(),
      events,
      invocationId,
      ownerFingerprint: run.attributes[OWNER_ATTRIBUTE] ?? "",
      revision: events.length,
    };
  }

  async update(
    invocationId: string,
    responses: Parameters<AgentInvocationRepository["update"]>[1],
  ): Promise<void> {
    const world = await getWorld();
    const run = await world.runs.get(invocationId, { resolveData: "none" });
    const token = run.attributes[TOKEN_ATTRIBUTE];
    if (token === undefined) throw new Error("Invocation has no continuation token.");
    await this.#agent.deliver({
      continuationToken: `${this.#channelName}:${token}`,
      payload: { inputResponses: responses },
    });
  }

  async cancel(invocationId: string): Promise<void> {
    await this.#agent.cancelTurn({ sessionId: invocationId });
  }
}
