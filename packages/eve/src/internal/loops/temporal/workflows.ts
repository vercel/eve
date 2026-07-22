import {
  condition,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

import type { HookPayload } from "#channel/types.js";
import { runSession, runTurn } from "#core/index.js";
import type { LoopRequest } from "#core/types.js";
import type {
  ChildrenHandle,
  CompletedTurn,
  GenerateInput,
  SessionAdvance,
  SessionBackend,
  SessionState,
  SuspendedTurn,
  TurnBackend,
  TurnHandle,
  TurnOutcome,
  TurnProgramInput,
} from "#internal/loops/types.js";
import {
  temporalLoopDeliverySignal,
  TEMPORAL_TURN_WORKFLOW,
  type TemporalLoopActivities,
  type TemporalLoopDelivery,
  type TemporalLoopTurnWorkflow,
  type TemporalLoopTurnWorkflowInput,
  type TemporalLoopWorkflowInput,
} from "./contracts.js";

const activities = proxyActivities<TemporalLoopActivities>({
  // Retrying a live model or authored-tool call would duplicate the workload.
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: "5 minutes",
});

/** Temporal session Workflow: a thin durable host for the shared session program. */
export async function temporalSessionWorkflow(rawInput: unknown): Promise<void> {
  const input = parseWorkflowInput(rawInput);
  if (workflowInfo().workflowId !== input.sessionId) {
    throw new Error(
      `Temporal Workflow "${workflowInfo().workflowId}" does not match session "${input.sessionId}".`,
    );
  }

  const deliveries: HookPayload[] = [];
  setHandler(temporalLoopDeliverySignal, (rawDelivery) => {
    deliveries.push(toHookPayload(parseDelivery(rawDelivery)));
  });
  const created = await activities.createSession({
    continuationToken: input.continuationToken,
    limits: input.limits,
    sessionId: input.sessionId,
  });
  await runSession(new TemporalSessionBackend(input.sessionId, deliveries), {
    capabilities: input.capabilities,
    initialDelivery: input.initialDelivery,
    mode: input.mode,
    state: { durable: created.state, serializedContext: input.serializedContext },
  });
}

/** Temporal child Workflow: a thin durable host for the shared turn program. */
export async function temporalTurnWorkflow(
  input: TemporalLoopTurnWorkflowInput,
): Promise<TurnOutcome> {
  if (workflowInfo().parent?.workflowId !== input.sessionId) {
    throw new Error(
      `Temporal turn parent "${workflowInfo().parent?.workflowId ?? "none"}" does not match session "${input.sessionId}".`,
    );
  }
  return await runTurn(new TemporalTurnBackend(input.sessionId, input.turnOrdinal), input.input);
}

class TemporalSessionBackend implements SessionBackend {
  readonly #deliveries: HookPayload[];
  readonly #sessionId: string;

  constructor(sessionId: string, deliveries: HookPayload[]) {
    this.#deliveries = deliveries;
    this.#sessionId = sessionId;
  }

  async finish(_turn: CompletedTurn): Promise<void> {
    await activities.settleSession({ sessionId: this.#sessionId });
  }

  async park(turn: SuspendedTurn): Promise<SessionAdvance> {
    if (turn.kind === "waiting" && turn.hasPendingAuthorization) {
      throw new Error("The Temporal loop implementation does not support authorization waits.");
    }
    if (turn.kind === "waiting" && turn.hasPendingInputBatch) {
      throw new Error("The Temporal loop implementation does not support input-request waits.");
    }
    await activities.rekeySession({
      continuationToken: turn.state.durable.continuationToken,
      sessionId: this.#sessionId,
    });
    await condition(() => this.#deliveries.length > 0);
    const delivery = this.#deliveries.shift();
    if (delivery?.kind !== "deliver") {
      throw new Error("Temporal loop delivery disappeared after its wait resolved.");
    }
    return { delivery, kind: "delivery", state: turn.state };
  }

  spawnTurn(input: TurnProgramInput, turnOrdinal: number): TurnHandle {
    const handle = startChild<TemporalLoopTurnWorkflow>(TEMPORAL_TURN_WORKFLOW, {
      args: [{ input, sessionId: this.#sessionId, turnOrdinal }],
      workflowId: `${this.#sessionId}:turn:${String(turnOrdinal)}`,
    });
    return { wait: async () => await (await handle).result() };
  }
}

class TemporalTurnBackend implements TurnBackend {
  readonly #sessionId: string;
  readonly #turnOrdinal: number;

  constructor(sessionId: string, turnOrdinal: number) {
    this.#sessionId = sessionId;
    this.#turnOrdinal = turnOrdinal;
  }

  async checkpoint(_state: SessionState): Promise<void> {}

  async generate(input: GenerateInput) {
    return await activities.executeTurnStep({
      input: input.input,
      serializedContext: input.state.serializedContext,
      sessionId: this.#sessionId,
      sessionState: input.state.durable,
      stepOrdinal: input.stepOrdinal,
      turnOrdinal: this.#turnOrdinal,
    });
  }

  async spawnChildren(
    _state: SessionState,
    requests: readonly LoopRequest[],
  ): Promise<{ readonly handle: ChildrenHandle; readonly state: SessionState }> {
    const kind = requests[0]?.kind;
    throw new Error(
      kind === "workflow-interrupt"
        ? "The Temporal loop implementation does not support workflow runtime actions."
        : "The Temporal loop implementation does not support subagent or runtime-action waits.",
    );
  }
}

function parseWorkflowInput(value: unknown): TemporalLoopWorkflowInput {
  const record = requireRecord(value, "Temporal loop Workflow input");
  return {
    capabilities: parseCapabilities(record["capabilities"]),
    continuationToken: requireString(record["continuationToken"], "continuationToken"),
    initialDelivery: parseInitialDelivery(record["initialDelivery"]),
    limits: parseLimits(record["limits"]),
    mode: requireConversationMode(record["mode"]),
    serializedContext: requireRecord(record["serializedContext"], "serializedContext"),
    sessionId: requireString(record["sessionId"], "sessionId"),
  };
}

function parseDelivery(value: unknown): TemporalLoopDelivery {
  const record = requireRecord(value, "Temporal loop delivery");
  return {
    auth: parseAuth(record["auth"]),
    message: requireString(record["message"], "message"),
    requestId: optionalString(record["requestId"], "requestId"),
  };
}

function parseInitialDelivery(value: unknown): TemporalLoopWorkflowInput["initialDelivery"] {
  const record = requireRecord(value, "initialDelivery");
  if (record["kind"] !== "deliver") {
    throw new TypeError('initialDelivery.kind must be "deliver".');
  }
  if (!Array.isArray(record["payloads"]) || record["payloads"].length !== 1) {
    throw new TypeError("initialDelivery.payloads must contain exactly one payload.");
  }
  const payload = requireRecord(record["payloads"][0], "initialDelivery.payloads[0]");
  return {
    auth: parseAuth(record["auth"]),
    kind: "deliver",
    payloads: [{ message: requireString(payload["message"], "initialDelivery message") }],
    requestId: optionalString(record["requestId"], "initialDelivery.requestId"),
  };
}

function parseCapabilities(value: unknown): TemporalLoopWorkflowInput["capabilities"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "capabilities");
  const requestInput = record["requestInput"];
  if (requestInput !== undefined && typeof requestInput !== "boolean") {
    throw new TypeError("capabilities.requestInput must be a boolean.");
  }
  return requestInput === undefined ? {} : { requestInput };
}

function parseLimits(value: unknown): TemporalLoopWorkflowInput["limits"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "limits");
  const maxInputTokensPerSession = parseTokenLimit(
    record["maxInputTokensPerSession"],
    "limits.maxInputTokensPerSession",
  );
  const maxOutputTokensPerSession = parseTokenLimit(
    record["maxOutputTokensPerSession"],
    "limits.maxOutputTokensPerSession",
  );
  return { maxInputTokensPerSession, maxOutputTokensPerSession };
}

function parseTokenLimit(value: unknown, name: string): number | false | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer or false.`);
  }
  return value;
}

function parseAuth(value: unknown): TemporalLoopDelivery["auth"] {
  if (value === undefined || value === null) return value;
  const record = requireRecord(value, "auth");
  const rawAttributes = requireRecord(record["attributes"], "auth.attributes");
  const attributes: Record<string, string | readonly string[]> = {};
  for (const [key, attribute] of Object.entries(rawAttributes)) {
    if (typeof attribute === "string") {
      attributes[key] = attribute;
      continue;
    }
    if (Array.isArray(attribute) && attribute.every((item) => typeof item === "string")) {
      attributes[key] = attribute;
      continue;
    }
    throw new TypeError(`auth.attributes.${key} must be a string or string array.`);
  }
  return {
    attributes,
    authenticator: requireString(record["authenticator"], "auth.authenticator"),
    issuer: optionalString(record["issuer"], "auth.issuer"),
    principalId: requireString(record["principalId"], "auth.principalId"),
    principalType: requireString(record["principalType"], "auth.principalType"),
    subject: optionalString(record["subject"], "auth.subject"),
  };
}

function requireConversationMode(value: unknown): "conversation" {
  if (value !== "conversation") {
    throw new TypeError('Temporal loop mode must be "conversation".');
  }
  return value;
}

function toHookPayload(delivery: TemporalLoopDelivery): HookPayload {
  return {
    auth: delivery.auth,
    kind: "deliver",
    payloads: [{ message: delivery.message }],
    requestId: delivery.requestId,
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireString(value, name);
}
