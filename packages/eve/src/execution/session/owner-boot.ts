import type {
  DeliverHookPayload,
  RunInput,
  SessionAuthContext,
  SessionCapabilities,
  SessionCommand,
} from "#channel/types.js";
import { readSerializedSessionSchedule } from "#context/session-schedule.js";
import type { AgentSessionRuntimeOverrides } from "#execution/agent-sessions/runtime-overrides.js";
import { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import {
  SESSION_INBOX_CONTEXT_KEY,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import {
  createSessionInbox,
  type InboxHook,
  type SessionInboxHandle,
  type SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { failSession, type SessionBoot } from "#execution/session/program.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import type { SessionTimeoutControl, SessionTimeouts } from "#execution/session/timeout-control.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";

// A session's first owner, on any host: creates the session, claims its addresses, and resolves
// its caller, then hands the session loop what it runs from. The host supplies where the session
// lives (`InitialOwnerPorts`).

/** A first owner, booted: its inbox and what its session loop runs from. */
export interface BootOutcome {
  readonly inbox: SessionInboxHandle;
  readonly session: SessionBoot;
}

/** `serializedContext` as the session `sessionId` runs it: its id, and its inbox's. */
export function stampSessionIdentity(
  serializedContext: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  return {
    ...serializedContext,
    "eve.sessionId": sessionId,
    [SESSION_INBOX_CONTEXT_KEY]: { sessionId },
  };
}

interface OwnedInitialSession {
  readonly kind: "owned";
  readonly timeoutControl: SessionTimeoutControl | undefined;
  readonly turnControl: TurnControl;
}

type InitialOwnerPreparation = OwnedInitialSession | { readonly kind: "alias-conflict" };

async function prepareInitialOwner(
  inbox: SessionInboxHandle,
  input: {
    readonly continuationToken: string;
    /** The claims confirm after it, so it runs inline while their hooks commit. */
    readonly sessionCreation: Promise<unknown>;
    readonly sessionId: string;
    readonly sessionTimeoutMs: number | false;
    readonly startClaim: InitialWorkflowEntryInput["startClaim"];
    readonly timeouts: SessionTimeouts;
  },
): Promise<InitialOwnerPreparation> {
  const owner: OwnedInitialSession = {
    kind: "owned",
    // The session loop starts the timer once the claims are confirmed; one
    // started sooner could signal a command hook that is not registered yet.
    timeoutControl: input.timeouts({
      sessionId: input.sessionId,
      timeoutMs: input.sessionTimeoutMs,
    }),
    // Created before any await so its abort hooks commit with the session's
    // hooks instead of beside the first turn's step.
    turnControl: createTurnControl(),
  };
  const claim = { confirmAfter: input.sessionCreation };
  const [stableClaim, aliasClaim] = await Promise.allSettled([
    inbox.claimSessionHook(
      sessionCommandHookToken(input.sessionId),
      input.startClaim === "inbox" ? { ...claim, claimedAtStart: true } : claim,
    ),
    input.continuationToken === ""
      ? Promise.resolve()
      : inbox.claimSessionHook(
          input.continuationToken,
          input.startClaim === "continuation" ? { ...claim, claimedAtStart: true } : claim,
        ),
  ]);
  if (stableClaim.status === "rejected") throw stableClaim.reason;
  if (aliasClaim.status === "rejected") {
    if (isHookConflictError(aliasClaim.reason)) return { kind: "alias-conflict" };
    throw aliasClaim.reason;
  }
  return owner;
}

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/**
 * Where a first owner keeps its session: the stream it writes, the transport its addresses
 * arrive on, its timers, and where a message for a continuation another session holds goes.
 * Each host supplies its own: Workflow's are on the owner's run (`workflowEntry`).
 */
export interface InitialOwnerPorts<Hook extends InboxHook = InboxHook> {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly inboxTransport: SessionInboxTransport<Hook>;
  readonly timeouts: SessionTimeouts;
  /** Hands the message to the session that holds `continuationToken`. */
  settleContinuationConflict(input: {
    readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
    readonly continuationToken: string;
  }): Promise<void>;
}

/** Returns `undefined` when a competing continuation owner already exists. */
export async function bootInitialOwner<Hook extends InboxHook>(
  input: InitialWorkflowEntryInput,
  sessionId: string,
  ports: InitialOwnerPorts<Hook>,
): Promise<BootOutcome | undefined> {
  const serializedContext = stampSessionIdentity(input.serializedContext, sessionId);
  const { sessionWritable } = ports;
  const inbox = createSessionInbox(ports.inboxTransport);
  const sessionTimeoutMs = input.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const continuationToken = (serializedContext["eve.continuationToken"] as string) || "";
  const serializedBundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  try {
    const sessionCreationPromise = createSessionStep({
      agentSessionRuntimeOverrides: serializedContext["eve.agentSessionRuntimeOverrides"] as
        | AgentSessionRuntimeOverrides
        | undefined,
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      dynamicSubagentAgentConfig: serializedContext["eve.dynamicSubagentAgentConfig"] as
        | DynamicSubagentAgentConfig
        | undefined,
      // With a first message, its delivery carries the history instead.
      history: input.input.message === undefined ? input.input.history : undefined,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: readRootSessionId(serializedContext),
      sessionId,
    });
    const ownerPreparationPromise = prepareInitialOwner(inbox, {
      continuationToken,
      sessionCreation: sessionCreationPromise,
      sessionId,
      sessionTimeoutMs,
      startClaim: input.startClaim,
      timeouts: ports.timeouts,
    });
    const callerResolutionPromise = hasDelegatedSessionContext(serializedContext)
      ? resolveInitialTurnCallerStep({ serializedContext })
      : Promise.resolve(undefined);
    const [sessionCreation, ownerPreparation, callerResolution] = await Promise.allSettled([
      sessionCreationPromise,
      ownerPreparationPromise,
      callerResolutionPromise,
    ]);
    const created = unwrapSettled(sessionCreation);
    const prepared = unwrapSettled(ownerPreparation);
    if (prepared.kind === "alias-conflict") {
      if (input.continuationConflictCommand !== undefined) {
        const conflict = { command: input.continuationConflictCommand, continuationToken };
        await ports.settleContinuationConflict(conflict);
      }
      await inbox.dispose();
      // This run never becomes the session, so nothing else would end its stream.
      await closeSessionStreamStep({ sessionWritable });
      return undefined;
    }
    const caller = unwrapSettled(callerResolution);
    return {
      inbox,
      session: {
        admittedDeliveryKeys: input.idempotencyKey === undefined ? [] : [input.idempotencyKey],
        anchor: { kind: "self" },
        caller,
        capabilities: serializedContext["eve.capabilities"] as SessionCapabilities | undefined,
        deploymentId: input.ownerDeploymentId,
        history: created.history,
        start:
          input.input.message === undefined
            ? { kind: "first-message" }
            : { input: createInitialDelivery(input, serializedContext), kind: "turn" },
        initialTurnControl: prepared.turnControl,
        retention: input.retention,
        serializedContext,
        sessionId,
        sessionState: created.state,
        sessionTimeoutControl: prepared.timeoutControl,
        sessionTimeoutMs,
        sessionWritable,
      },
    };
  } catch (error) {
    await inbox.dispose();
    return await failSession({
      error,
      serializedContext,
      sessionId,
      sessionState: undefined,
      sessionWritable,
    });
  }
}

function createInitialDelivery(
  input: InitialWorkflowEntryInput,
  serializedContext: Record<string, unknown>,
): DeliverHookPayload | undefined {
  if (input.input.message === undefined) return undefined;
  return {
    auth: serializedContext["eve.auth"] as SessionAuthContext | null | undefined,
    idempotencyKey: input.idempotencyKey,
    schedule: readSerializedSessionSchedule(serializedContext),
    deliveryMetadata:
      serializedContext["eve.channelDelivery"] === undefined
        ? undefined
        : [
            {
              ...(serializedContext["eve.channelDelivery"] as NonNullable<RunInput["delivery"]>),
              payloadIndex: 0,
            },
          ],
    kind: "deliver",
    payloads: [
      attachClientContext(
        {
          message: input.input.message,
          context: input.input.context,
          history: input.input.history,
          outputSchema: input.input.outputSchema,
          state: input.input.state,
        },
        readClientContext(input.input),
      ),
    ],
    requestId: readChannelRequestId(serializedContext),
  };
}
