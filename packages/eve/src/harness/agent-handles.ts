import { createHash } from "node:crypto";

import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";

/** Session-state key for delegated agent handles. */
export const AGENT_HANDLES_STATE_KEY = "eve.agent.handles";
const AGENTS_SNIPPET_LABEL = "[Agents]";
const MAX_STATUS_LENGTH = 120;

/** Error code for a requested agent id that is not registered. */
export const AGENT_UNKNOWN = "AGENT_UNKNOWN";

/** Error code for an agent id invoked through the wrong subagent tool. */
export const AGENT_MISMATCH = "AGENT_MISMATCH";

/** Error code for a registered agent that cannot be reached. */
export const AGENT_UNREACHABLE = "AGENT_UNREACHABLE";

/** Error code for an agent that is starting or already running a turn. */
export const AGENT_BUSY = "AGENT_BUSY";

/**
 * Stable identity of one delegated child, minted before its start side
 * effect runs. The model-visible `id` derives from the first start
 * operation, never from the child session id, so it exists before the
 * child does and cannot collide on externally supplied session suffixes.
 */
export interface AgentIdentity {
  /** Model-visible identifier: `ag_<name>:<operation-hash>`. */
  readonly id: string;
  /** Subagent tool name. */
  readonly name: string;
  /** Agent-graph node used to re-resolve delivery configuration. */
  readonly nodeId: string;
}

/**
 * One dispatch the parent intends to perform or has performed. Repeating
 * the same operation is a replay; a different operation against a
 * starting/running handle is a busy conflict.
 */
export interface StartOperation {
  readonly kind: "start";
  /** Derived via {@link deriveAgentOperationId}; stable across replays. */
  readonly id: string;
  readonly callId: string;
  readonly parentTurnId: string;
}

/** A continuation delivery against a parked handle. */
export interface ContinueOperation {
  readonly kind: "continue";
  /** Derived via {@link deriveAgentOperationId}; stable across replays. */
  readonly id: string;
  readonly callId: string;
  readonly parentTurnId: string;
  /**
   * Status the handle showed before this delivery, restored when the
   * delivery is rejected as retryable so the handle returns to `parked`
   * without optional state.
   */
  readonly previousStatus: string;
}

/** Where a fresh child will be started. No session exists yet. */
export type AgentStartTarget =
  | {
      readonly kind: "agent/local";
      /** Deterministic child continuation token chosen at dispatch. */
      readonly continuationToken: string;
    }
  | {
      readonly kind: "agent/self";
      readonly continuationToken: string;
    }
  | {
      readonly kind: "agent/remote";
      /** Deliver target base URL; never model-visible. */
      readonly url: string;
      /** Callback base URL stub captured at dispatch; never model-visible. */
      readonly callbackBaseUrl: string;
    };

/** Confirmed delivery coordinates of a started child. */
export type AgentAddress =
  | {
      readonly kind: "agent/local";
      readonly sessionId: string;
      readonly continuationToken: string;
    }
  | {
      readonly kind: "agent/self";
      readonly sessionId: string;
      readonly continuationToken: string;
    }
  | {
      readonly kind: "agent/remote";
      readonly sessionId: string;
      readonly continuationToken: string;
      readonly url: string;
      readonly callbackBaseUrl: string;
    };

/**
 * Durable ownership record for one delegated child.
 *
 * The store owns the full nonterminal lifecycle:
 *
 * - `starting` — the parent committed intent to start; the child may or
 *   may not exist yet.
 * - `running` — one identified child turn is outstanding.
 * - `parked` — the child is idle and resumable; only this phase is
 *   model-visible.
 *
 * A terminal child has no handle: settlement deletes it.
 */
export type AgentHandle =
  | {
      readonly phase: "starting";
      readonly identity: AgentIdentity;
      readonly operation: StartOperation;
      readonly target: AgentStartTarget;
    }
  | {
      readonly phase: "running";
      readonly identity: AgentIdentity;
      readonly operation: StartOperation | ContinueOperation;
      readonly address: AgentAddress;
    }
  | {
      readonly phase: "parked";
      readonly identity: AgentIdentity;
      readonly address: AgentAddress;
      readonly lastStatus: string;
    };

/** Lifecycle phase of a delegated agent handle. */
export type AgentHandlePhase = AgentHandle["phase"];

/** Session-state collection of delegated agent handles. */
export interface AgentHandleStore {
  readonly handles: readonly AgentHandle[];
}

const nonEmptyString = z.string().min(1);

const identitySchema = z.strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  nodeId: nonEmptyString,
});

const startOperationSchema = z.strictObject({
  callId: nonEmptyString,
  id: nonEmptyString,
  kind: z.literal("start"),
  parentTurnId: nonEmptyString,
});

const continueOperationSchema = z.strictObject({
  callId: nonEmptyString,
  id: nonEmptyString,
  kind: z.literal("continue"),
  parentTurnId: nonEmptyString,
  previousStatus: z.string().max(MAX_STATUS_LENGTH),
});

const startTargetSchema: z.ZodType<AgentStartTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ continuationToken: nonEmptyString, kind: z.literal("agent/local") }),
  z.strictObject({ continuationToken: nonEmptyString, kind: z.literal("agent/self") }),
  z.strictObject({
    callbackBaseUrl: z.url(),
    kind: z.literal("agent/remote"),
    url: z.url(),
  }),
]);

const addressSchema: z.ZodType<AgentAddress> = z.discriminatedUnion("kind", [
  z.strictObject({
    continuationToken: nonEmptyString,
    kind: z.literal("agent/local"),
    sessionId: nonEmptyString,
  }),
  z.strictObject({
    continuationToken: nonEmptyString,
    kind: z.literal("agent/self"),
    sessionId: nonEmptyString,
  }),
  z.strictObject({
    callbackBaseUrl: z.url(),
    continuationToken: nonEmptyString,
    kind: z.literal("agent/remote"),
    sessionId: nonEmptyString,
    url: z.url(),
  }),
]);

const agentHandleSchema: z.ZodType<AgentHandle> = z.discriminatedUnion("phase", [
  z.strictObject({
    identity: identitySchema,
    operation: startOperationSchema,
    phase: z.literal("starting"),
    target: startTargetSchema,
  }),
  z.strictObject({
    address: addressSchema,
    identity: identitySchema,
    operation: z.discriminatedUnion("kind", [startOperationSchema, continueOperationSchema]),
    phase: z.literal("running"),
  }),
  z.strictObject({
    address: addressSchema,
    identity: identitySchema,
    lastStatus: z.string().max(MAX_STATUS_LENGTH),
    phase: z.literal("parked"),
  }),
]);

const agentHandleStoreSchema: z.ZodType<AgentHandleStore> = z
  .strictObject({
    handles: z.array(agentHandleSchema),
  })
  .refine(
    (store) =>
      new Set(store.handles.map((handle) => handle.identity.id)).size === store.handles.length,
    { message: "Agent handle ids must be unique." },
  );

/**
 * Derives the stable operation id for one dispatch. All three inputs are
 * parent-controlled, so the id exists before any child does and replaying
 * the same call produces the same operation.
 */
export function deriveAgentOperationId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return createHash("sha256")
    .update(`${input.parentSessionId}\0${input.parentTurnId}\0${input.callId}`)
    .digest("hex");
}

/** Derives the model-visible agent id from the first start operation. */
export function deriveAgentId(name: string, startOperationId: string): string {
  return `ag_${name}:${startOperationId.slice(0, 12)}`;
}

/** Collapses whitespace and truncates output into a handle status line. */
export function formatAgentStatus(output: unknown): string {
  const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
  return text.replaceAll(/\s+/g, " ").trim().slice(0, MAX_STATUS_LENGTH);
}

/**
 * Reads and validates the agent handle store from session state.
 *
 * Returns `undefined` only when no store has been written. A present but
 * invalid store throws: treating corruption as absence would let the next
 * transition silently replace every delegated child's delivery coordinates.
 */
export function getAgentHandleStore(
  state: SessionStateMap | undefined,
): AgentHandleStore | undefined {
  const raw = state?.[AGENT_HANDLES_STATE_KEY];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = agentHandleStoreSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Corrupt agent handle store under session state key "${AGENT_HANDLES_STATE_KEY}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Records intent to start a fresh child. Must commit before the start
 * side effect runs so a crashed dispatch never orphans an unowned child.
 *
 * Throws when the identity or operation already exists: fresh starts mint
 * a new identity, so a collision means corrupted derivation, not a replay.
 */
export function prepareAgentStart(
  session: HarnessSession,
  input: {
    readonly identity: AgentIdentity;
    readonly operation: StartOperation;
    readonly target: AgentStartTarget;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  if (handles.some((handle) => handle.identity.id === input.identity.id)) {
    throw new Error(`Agent handle "${input.identity.id}" already exists.`);
  }
  return writeHandles(session, [
    ...handles,
    {
      identity: input.identity,
      operation: input.operation,
      phase: "starting",
      target: input.target,
    },
  ]);
}

/** Result of preparing a continuation against an existing handle. */
export type PrepareAgentContinuationResult =
  | {
      readonly kind: "ready";
      readonly session: HarnessSession;
      readonly handle: Extract<AgentHandle, { phase: "running" }>;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "busy" };

/**
 * Records intent to deliver a follow-up turn to a parked child. Must
 * commit before the delivery side effect runs.
 *
 * `unknown`, `mismatch`, and `busy` do not change the session; the caller
 * maps them onto {@link AGENT_UNKNOWN}, {@link AGENT_MISMATCH}, and
 * {@link AGENT_BUSY} results. Replaying the operation already recorded on
 * a running handle returns `ready` with the unchanged session.
 */
export function prepareAgentContinuation(
  session: HarnessSession,
  input: {
    readonly agentId: string;
    readonly invokedName: string;
    readonly operation: ContinueOperation;
  },
): PrepareAgentContinuationResult {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = handles.find((handle) => handle.identity.id === input.agentId);
  if (existing === undefined) {
    return { kind: "unknown" };
  }
  if (existing.identity.name !== input.invokedName) {
    return { kind: "mismatch" };
  }
  if (existing.phase === "running" && existing.operation.id === input.operation.id) {
    return { handle: existing, kind: "ready", session };
  }
  if (existing.phase !== "parked") {
    return { kind: "busy" };
  }

  const running: Extract<AgentHandle, { phase: "running" }> = {
    address: existing.address,
    identity: existing.identity,
    operation: { ...input.operation, previousStatus: existing.lastStatus },
    phase: "running",
  };
  return {
    handle: running,
    kind: "ready",
    session: writeHandles(
      session,
      handles.map((handle) => (handle.identity.id === input.agentId ? running : handle)),
    ),
  };
}

type ActiveAgentHandle = Extract<AgentHandle, { phase: "starting" | "running" }>;

function findActiveHandle(
  handles: readonly AgentHandle[],
  operationId: string,
): ActiveAgentHandle | undefined {
  return handles.find(
    (handle): handle is ActiveAgentHandle =>
      handle.phase !== "parked" && handle.operation.id === operationId,
  );
}

/**
 * Confirms a started child: `starting` becomes `running` with the child's
 * confirmed address. Throws when no starting handle carries the operation,
 * because confirming an unprepared start means ownership was never
 * committed. Re-confirming an already-running handle with the same
 * operation and address is a replay no-op.
 */
export function confirmAgentStarted(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly address: AgentAddress;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = findActiveHandle(handles, input.operationId);
  if (existing === undefined) {
    throw new Error(`No prepared agent handle for operation "${input.operationId}".`);
  }
  if (existing.phase === "running") {
    return session;
  }

  return writeHandles(
    session,
    handles.map((handle) =>
      handle === existing
        ? {
            address: input.address,
            identity: existing.identity,
            operation: existing.operation,
            phase: "running",
          }
        : handle,
    ),
  );
}

/**
 * Resolves a dispatch that definitively failed.
 *
 * - A dead start or dead continuation deletes the handle: there is no
 *   child left to own.
 * - A retryable continuation failure restores `parked` with the status the
 *   handle showed before the delivery, so the model may retry the same
 *   `agentId` later.
 *
 * Unknown operations are a no-op: the failure raced a settlement that
 * already resolved the handle.
 */
export function rejectAgentEffect(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly disposition: "dead" | "retryable";
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = findActiveHandle(handles, input.operationId);
  if (existing === undefined) {
    return session;
  }

  if (input.disposition === "retryable" && existing.phase === "running") {
    const { operation } = existing;
    if (operation.kind === "continue") {
      return writeHandles(
        session,
        handles.map((handle) =>
          handle === existing
            ? {
                address: existing.address,
                identity: existing.identity,
                lastStatus: operation.previousStatus,
                phase: "parked",
              }
            : handle,
        ),
      );
    }
  }

  return writeHandles(
    session,
    handles.filter((handle) => handle !== existing),
  );
}

/** Result of applying a settled child turn to the store. */
export type SettleAgentTurnResult =
  | { readonly kind: "settled"; readonly session: HarnessSession }
  | { readonly kind: "ignored"; readonly reason: "unknown-operation" | "session-mismatch" };

/**
 * Applies one settled child turn: `running` becomes `parked` for a parked
 * outcome or is deleted for a terminal outcome.
 *
 * The settlement must carry the operation currently recorded on the
 * running handle and the child session the address confirms; anything else
 * is ignored so a stale or forged delivery can never move a newer turn.
 */
export function settleAgentTurn(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly outcome: AgentTurnOutcome;
  },
): SettleAgentTurnResult {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = handles.find(
    (handle) => handle.phase === "running" && handle.operation.id === input.operationId,
  );
  if (existing === undefined || existing.phase !== "running") {
    return { kind: "ignored", reason: "unknown-operation" };
  }
  if (existing.address.sessionId !== input.sessionId) {
    return { kind: "ignored", reason: "session-mismatch" };
  }

  if (input.outcome.kind === "terminal") {
    return {
      kind: "settled",
      session: writeHandles(
        session,
        handles.filter((handle) => handle !== existing),
      ),
    };
  }

  const { result } = input.outcome;
  const lastStatus =
    result.kind === "succeeded"
      ? formatAgentStatus(result.output)
      : result.kind === "failed"
        ? formatAgentStatus(result.error)
        : "(cancelled)";
  return {
    kind: "settled",
    session: writeHandles(
      session,
      handles.map((handle) =>
        handle === existing
          ? {
              address: existing.address,
              identity: existing.identity,
              lastStatus,
              phase: "parked",
            }
          : handle,
      ),
    ),
  };
}

/** Returns the resumable handles: the only phase the model may continue. */
export function projectParkedAgentHandles(
  store: AgentHandleStore,
): readonly Extract<AgentHandle, { phase: "parked" }>[] {
  return store.handles.filter((handle) => handle.phase === "parked");
}

/**
 * Renders the model-visible agent listing. Only parked handles appear:
 * starting and running children cannot accept a continuation, and private
 * delivery coordinates never render.
 */
export function renderAgentsSnippet(store: AgentHandleStore): string {
  const agents = projectParkedAgentHandles(store).map(
    (handle) =>
      `<agent id="${escapeXml(handle.identity.id)}" name="${escapeXml(handle.identity.name)}">${escapeXml(handle.lastStatus === "" ? "(no status)" : handle.lastStatus)}</agent>`,
  );
  return [AGENTS_SNIPPET_LABEL, "<agents>", ...agents, "</agents>"].join("\n");
}

function writeHandles(session: HarnessSession, handles: readonly AgentHandle[]): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [AGENT_HANDLES_STATE_KEY]: { handles } satisfies AgentHandleStore,
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
