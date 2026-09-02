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
      /** Auth/header resolver selected when this child was created; `{}` means none. */
      readonly credentialResolver?: { readonly resolverId?: string };
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
      readonly url: string;
      readonly callbackBaseUrl: string;
      /** Auth/header resolver selected when this child was created; `{}` means none. */
      readonly credentialResolver?: { readonly resolverId?: string };
    };

/**
 * Parent-turn-owned lifecycle: `starting → running → parked ↔ running`.
 *
 * `starting` owns a start intent before the child has an address, `running`
 * owns one outstanding child turn, and `parked` retains an idle, resumable
 * child. A terminal child or dead dispatch leaves this union entirely.
 */
export type TurnOwnedAgentHandle =
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

/**
 * Workflow-owner lifecycle: `reserved → claimed → available ↔ claimed`.
 *
 * `reserved` leases a fresh identity before start, `claimed` leases an
 * addressed child turn to one task or workflow-tool run, and `available`
 * retains the idle address between invocations. A terminal child leaves this
 * union entirely.
 */
export type TaskOwnedAgentHandle =
  | {
      /** Fresh identity leased to one owner before the child's address is confirmed. */
      readonly phase: "reserved";
      readonly identity: AgentIdentity;
      readonly operationId: string;
      readonly callId?: string;
      readonly ownerId: string;
    }
  | {
      /** Addressed child turn leased until its owner releases it. */
      readonly phase: "claimed";
      readonly identity: AgentIdentity;
      readonly operationId: string;
      readonly callId?: string;
      readonly address: AgentAddress;
      readonly ownerId: string;
    }
  | {
      /** Idle addressed child with no owner lease, ready for a later invocation to claim. */
      readonly phase: "available";
      readonly identity: AgentIdentity;
      readonly address: AgentAddress;
      readonly lastStatus?: string;
    };

/**
 * Durable ownership record for one delegated child.
 *
 * The two execution policies share an identity namespace and serialized store,
 * but their lifecycle states and transitions are disjoint. A terminal child has
 * no handle: settlement deletes it.
 */
export type AgentHandle = TurnOwnedAgentHandle | TaskOwnedAgentHandle;

/** Lifecycle phase of a delegated agent handle. */
export type AgentHandlePhase = AgentHandle["phase"];

/** Session-state collection of delegated agent handles. */
export interface AgentHandleStore {
  readonly handles: readonly AgentHandle[];
}

export const EMPTY_AGENT_HANDLE_STORE: AgentHandleStore = { handles: [] };

/** One serialized owner-lease mutation against the shared agent handle store. */
export type AgentHandleStoreCommand =
  | { readonly kind: "read" }
  | {
      readonly identity: AgentIdentity;
      readonly kind: "reserve";
      readonly operationId: string;
      readonly callId?: string;
      readonly ownerId: string;
    }
  | {
      readonly address: AgentAddress;
      readonly kind: "confirm";
      readonly operationId: string;
      readonly ownerId: string;
    }
  | {
      readonly agentId: string;
      readonly expectedTarget: "local" | "remote";
      readonly callId?: string;
      readonly invokedName: string;
      readonly kind: "claim";
      readonly operationId: string;
      readonly ownerId: string;
    }
  | { readonly agentId: string; readonly kind: "remove"; readonly ownerId: string }
  | { readonly kind: "release-owner"; readonly lastStatus?: string; readonly ownerId: string };

export type AgentHandleStoreCommandResult =
  | { readonly kind: "ready"; readonly handle?: TaskOwnedAgentHandle }
  | { readonly kind: "busy"; readonly handle: AgentHandle }
  | { readonly kind: "mismatch"; readonly handle: AgentHandle }
  | { readonly kind: "unknown" };

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
    credentialResolver: z.strictObject({ resolverId: nonEmptyString.optional() }).optional(),
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
    credentialResolver: z.strictObject({ resolverId: nonEmptyString.optional() }).optional(),
    kind: z.literal("agent/remote"),
    sessionId: nonEmptyString,
    url: z.url(),
  }),
]);

const agentHandleStoreCommandSchema: z.ZodType<AgentHandleStoreCommand> = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("read") }),
    z.strictObject({
      identity: identitySchema,
      callId: nonEmptyString.optional(),
      kind: z.literal("reserve"),
      operationId: nonEmptyString,
      ownerId: nonEmptyString,
    }),
    z.strictObject({
      address: addressSchema,
      kind: z.literal("confirm"),
      operationId: nonEmptyString,
      ownerId: nonEmptyString,
    }),
    z.strictObject({
      agentId: nonEmptyString,
      callId: nonEmptyString.optional(),
      expectedTarget: z.enum(["local", "remote"]),
      invokedName: nonEmptyString,
      kind: z.literal("claim"),
      operationId: nonEmptyString,
      ownerId: nonEmptyString,
    }),
    z.strictObject({
      agentId: nonEmptyString,
      kind: z.literal("remove"),
      ownerId: nonEmptyString,
    }),
    z.strictObject({
      kind: z.literal("release-owner"),
      lastStatus: z.string().max(MAX_STATUS_LENGTH).optional(),
      ownerId: nonEmptyString,
    }),
  ],
);

const turnOwnedAgentHandleSchema: z.ZodType<TurnOwnedAgentHandle> = z.discriminatedUnion("phase", [
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

const taskOwnedAgentHandleSchema: z.ZodType<TaskOwnedAgentHandle> = z.discriminatedUnion("phase", [
  z.strictObject({
    callId: nonEmptyString.optional(),
    identity: identitySchema,
    operationId: nonEmptyString,
    phase: z.literal("reserved"),
    ownerId: nonEmptyString,
  }),
  z.strictObject({
    address: addressSchema,
    callId: nonEmptyString.optional(),
    identity: identitySchema,
    operationId: nonEmptyString,
    phase: z.literal("claimed"),
    ownerId: nonEmptyString,
  }),
  z.strictObject({
    address: addressSchema,
    identity: identitySchema,
    lastStatus: z.string().max(MAX_STATUS_LENGTH).optional(),
    phase: z.literal("available"),
  }),
]);

const agentHandleSchema: z.ZodType<AgentHandle> = z.union([
  turnOwnedAgentHandleSchema,
  taskOwnedAgentHandleSchema,
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

/** Parses one complete command before the session inbox routes it to the handle store. */
export function parseAgentHandleStoreCommand(value: unknown): AgentHandleStoreCommand | undefined {
  const parsed = agentHandleStoreCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

/** Writes the validated agent handle store under its single session-state key. */
export function setAgentHandleStore(
  state: SessionStateMap | undefined,
  store: AgentHandleStore,
): SessionStateMap {
  return {
    ...state,
    [AGENT_HANDLES_STATE_KEY]: assertPersistableAgentHandleStore(store),
  };
}

/** Writes a validated handle list to a session-shaped value. */
export function writeHandles<Session extends { readonly state?: SessionStateMap }>(
  session: Session,
  handles: readonly AgentHandle[],
): Session {
  return {
    ...session,
    state: setAgentHandleStore(session.state, { handles }),
  };
}
