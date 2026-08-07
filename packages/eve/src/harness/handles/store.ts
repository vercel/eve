import { z } from "#compiled/zod/index.js";

import type { SessionStateMap } from "#harness/types.js";

import { AGENT_HANDLES_STATE_KEY } from "./state-key.js";

export { AGENT_HANDLES_STATE_KEY };

const MAX_STATUS_LENGTH = 120;

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
      /**
       * Absent when the remote deployment predates continuation tokens; the
       * child completes as a task-mode one-shot and can never be continued.
       */
      readonly continuationToken?: string;
      readonly url: string;
      readonly callbackBaseUrl: string;
    };

/**
 * Durable ownership record for one delegated child.
 *
 * Outside tasks mode, the store owns the full nonterminal lifecycle:
 *
 * - `starting` — the parent committed intent to start; the child may or
 *   may not exist yet.
 * - `running` — one identified child turn is outstanding.
 * - `parked` — the child is idle and resumable; only this phase is
 *   model-visible.
 *
 * A terminal child has no legacy handle: settlement deletes it. Tasks mode
 * instead keeps an `addressed` record whose availability is derived from the
 * tasks bound to its persistent child session.
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
    }
  | {
      /** Persistent task-mode identity and routing, with no execution claim. */
      readonly phase: "addressed";
      readonly identity: AgentIdentity;
      readonly address: AgentAddress;
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
    continuationToken: nonEmptyString.optional(),
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
  z.strictObject({
    address: addressSchema,
    identity: identitySchema,
    phase: z.literal("addressed"),
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
 * Validates one agent handle store about to be persisted, returning the
 * parsed value. Throws instead of writing an invalid store: transitions run
 * this on every write, which is the invariant that lets the schema-free
 * driver-side reader (`query.ts`) trust stored values without revalidating.
 */
export function assertPersistableAgentHandleStore(store: AgentHandleStore): AgentHandleStore {
  const parsed = agentHandleStoreSchema.safeParse(store);
  if (!parsed.success) {
    throw new Error(`Refusing to persist a corrupt agent handle store: ${parsed.error.message}`);
  }
  return parsed.data;
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
