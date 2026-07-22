import type {
  CancelTurnInput,
  CancelTurnResult,
  DeliverHookPayload,
  DeliverInput,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
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
import { activeTurnId } from "#harness/active-turn-id.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { executeTurnStepOperation } from "#internal/loops/turn-step-operation.js";
import { InMemoryLoopEventLog } from "#internal/loops/event-log.js";
import type { TimedHandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const INLINE_RUNTIME_GLOBAL_KEY = Symbol.for("eve.loops.inline-runtime");

interface InlineRuntimeGlobal {
  readonly sessionIdByContinuationToken: Map<string, string>;
  readonly sessionsById: Map<string, InlineSession>;
}

interface InlineRuntimeGlobalContainer {
  [INLINE_RUNTIME_GLOBAL_KEY]?: InlineRuntimeGlobal;
}

type InlineSessionPhase = "done" | "failed" | "initializing" | "parked" | "running";

interface InlineSession {
  abortController: AbortController | undefined;
  continuationToken: string;
  deliveryWaiter: ((delivery: DeliverHookPayload) => void) | undefined;
  readonly eventLog: InMemoryLoopEventLog;
  eventOrdinal: number;
  readonly id: string;
  readonly pendingDeliveries: DeliverHookPayload[];
  phase: InlineSessionPhase;
  state: SessionState | undefined;
}

const globalContainer = globalThis as typeof globalThis & InlineRuntimeGlobalContainer;

/** Creates the process-local implementation of the channel Runtime port. */
export function createInlineLoopRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}): Runtime {
  const global = getInlineRuntimeGlobal();

  return {
    async run(input: RunInput): Promise<RunHandle> {
      assertSupportedRunInput(input);

      const sessionId = createSessionId(global);
      const continuationToken = input.continuationToken ?? sessionId;
      const session: InlineSession = {
        abortController: undefined,
        continuationToken,
        deliveryWaiter: undefined,
        eventLog: new InMemoryLoopEventLog(),
        eventOrdinal: 0,
        id: sessionId,
        pendingDeliveries: [],
        phase: "initializing",
        state: undefined,
      };

      claimContinuationToken(global, session);
      global.sessionsById.set(sessionId, session);
      void initializeAndRunSession({ config, global, runInput: input, session }).catch(
        (error: unknown) => {
          session.phase = "failed";
          releaseContinuationToken(global, session);
          session.eventLog.fail(error);
        },
      );

      let events: ReadableStream<TimedHandleMessageStreamEvent> | undefined;
      return {
        continuationToken,
        get events() {
          events ??= session.eventLog.stream();
          return events;
        },
        sessionId,
      };
    },

    async cancelTurn(input: CancelTurnInput): Promise<CancelTurnResult> {
      const session = global.sessionsById.get(input.sessionId);
      const controller = session?.abortController;
      const state = session?.state;
      if (session === undefined || controller === undefined || state === undefined) {
        return { status: "no_active_turn" };
      }
      if (
        input.turnId !== undefined &&
        input.turnId !== activeTurnId(state.durable.emissionState)
      ) {
        return { status: "no_active_turn" };
      }
      controller.abort();
      return { status: "accepted" };
    },

    async deliver(input: DeliverInput): Promise<{ sessionId: string }> {
      const sessionId = global.sessionIdByContinuationToken.get(input.continuationToken);
      const session = sessionId === undefined ? undefined : global.sessionsById.get(sessionId);
      if (session === undefined || session.phase === "done" || session.phase === "failed") {
        throw new RuntimeNoActiveSessionError(input.continuationToken);
      }

      enqueueDelivery(session, {
        auth: input.auth,
        kind: "deliver",
        payloads: [input.payload],
        requestId: input.requestId,
      });
      return { sessionId: session.id };
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<TimedHandleMessageStreamEvent>> {
      const session = global.sessionsById.get(sessionId);
      if (session === undefined)
        throw new Error(`Inline loop session "${sessionId}" was not found.`);
      return session.eventLog.stream(options?.startIndex);
    },

    async resolveSession(continuationToken: string) {
      const sessionId = global.sessionIdByContinuationToken.get(continuationToken);
      return sessionId === undefined ? undefined : { sessionId };
    },
  };
}

async function initializeAndRunSession(input: {
  readonly config: {
    readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
    readonly nodeId?: string;
  };
  readonly global: InlineRuntimeGlobal;
  readonly runInput: RunInput;
  readonly session: InlineSession;
}): Promise<void> {
  const { config, global, runInput, session } = input;
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: config.compiledArtifactsSource,
    nodeId: config.nodeId,
  });
  const context = buildRunContext({ bundle, run: runInput });
  context.set(ContinuationTokenKey, session.continuationToken);
  context.set(SessionIdKey, session.id);
  const serializedContext = serializeContext(context);
  const { state: durable } = await createSessionStep({
    compiledArtifactsSource: serializeDurableCompiledArtifactsSource(
      config.compiledArtifactsSource,
    ),
    continuationToken: session.continuationToken,
    inheritedLimits: runInput.limits,
    nodeId: config.nodeId,
    outputSchema: runInput.input.outputSchema,
    sessionId: session.id,
  });
  const state = { durable, serializedContext };
  session.state = state;
  session.phase = "running";

  const backend = new InlineSessionBackend({ global, session });
  await runSession(backend, {
    capabilities: runInput.capabilities,
    initialDelivery: {
      kind: "deliver",
      payloads: [
        {
          context: runInput.input.context,
          message: runInput.input.message,
          outputSchema: runInput.input.outputSchema,
        },
      ],
      requestId: runInput.requestId,
    },
    mode: runInput.mode,
    state,
  });
}

class InlineSessionBackend implements SessionBackend {
  readonly #global: InlineRuntimeGlobal;
  readonly #session: InlineSession;

  constructor(input: { readonly global: InlineRuntimeGlobal; readonly session: InlineSession }) {
    this.#global = input.global;
    this.#session = input.session;
  }

  async finish(turn: CompletedTurn): Promise<void> {
    this.#session.state = turn.state;
    this.#session.phase = "done";
    releaseContinuationToken(this.#global, this.#session);
  }

  async park(turn: SuspendedTurn): Promise<SessionAdvance> {
    if (turn.kind === "waiting") assertSupportedWait(turn);
    this.#session.state = turn.state;
    rekeyContinuationToken(this.#global, this.#session, turn.state.durable.continuationToken);
    this.#session.phase = "parked";
    const delivery = await waitForDelivery(this.#session);
    this.#session.phase = "running";
    return { delivery, kind: "delivery", state: turn.state };
  }

  spawnTurn(input: TurnProgramInput, _turnOrdinal: number): TurnHandle {
    const controller = new AbortController();
    this.#session.abortController = controller;
    this.#session.state = input.state;
    return {
      wait: async (): Promise<TurnOutcome> => {
        try {
          return await runTurn(
            new InlineTurnBackend({
              abortSignal: controller.signal,
              session: this.#session,
            }),
            input,
          );
        } finally {
          if (this.#session.abortController === controller) {
            this.#session.abortController = undefined;
          }
        }
      },
    };
  }
}

class InlineTurnBackend implements TurnBackend {
  readonly #abortSignal: AbortSignal;
  readonly #parentWritable: WritableStream<Uint8Array>;
  readonly #session: InlineSession;

  constructor(input: { readonly abortSignal: AbortSignal; readonly session: InlineSession }) {
    this.#abortSignal = input.abortSignal;
    this.#session = input.session;
    this.#parentWritable = createEventWritable(input.session);
  }

  async checkpoint(state: SessionState): Promise<void> {
    this.#session.state = state;
  }

  async generate(input: GenerateInput) {
    const durableSession = await readDurableSession(input.state.durable);
    const generated = await executeTurnStepOperation({
      abortSignal: this.#abortSignal,
      callbackBaseUrl: undefined,
      createRuntime: createInlineLoopRuntime,
      durableSession,
      input: input.input,
      parentWritable: this.#parentWritable,
      serializedContext: input.state.serializedContext,
      sessionState: input.state.durable,
      writeEveAttributes: undefined,
    });
    this.#session.state = generated.state;
    return generated;
  }

  async spawnChildren(
    _state: SessionState,
    requests: readonly LoopRequest[],
  ): Promise<{ readonly handle: ChildrenHandle; readonly state: SessionState }> {
    const kind = requests[0]?.kind;
    throw new Error(
      kind === "workflow-interrupt"
        ? "The inline loop implementation does not support workflow runtime actions."
        : "The inline loop implementation does not support subagent or runtime-action waits.",
    );
  }
}

function createEventWritable(session: InlineSession): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(encoded) {
      const event = JSON.parse(
        new TextDecoder().decode(encoded).trim(),
      ) as TimedHandleMessageStreamEvent;
      session.eventLog.append({
        encoded,
        event,
        publicationKey: `${session.id}:${String(session.eventOrdinal++)}`,
      });
    },
  });
}

function assertSupportedRunInput(input: RunInput): void {
  if (input.mode !== "conversation") {
    throw new Error("The inline loop implementation only supports conversation mode.");
  }
  if (input.parent !== undefined || input.subagentDepth !== undefined) {
    throw new Error("The inline loop implementation does not support delegated subagent runs.");
  }
  if (input.callback !== undefined) {
    throw new Error("The inline loop implementation does not support session callbacks.");
  }
}

function assertSupportedWait(turn: Extract<TurnOutcome, { readonly kind: "waiting" }>): void {
  if (turn.hasPendingAuthorization || turn.authorizationNames?.length) {
    throw new Error("The inline loop implementation does not support authorization approvals.");
  }
  if (turn.hasPendingInputBatch) {
    throw new Error("The inline loop implementation does not support human input waits.");
  }
}

function getInlineRuntimeGlobal(): InlineRuntimeGlobal {
  globalContainer[INLINE_RUNTIME_GLOBAL_KEY] ??= {
    sessionIdByContinuationToken: new Map(),
    sessionsById: new Map(),
  };
  return globalContainer[INLINE_RUNTIME_GLOBAL_KEY];
}

function createSessionId(global: InlineRuntimeGlobal): string {
  let sessionId: string;
  do sessionId = `inline_${crypto.randomUUID()}`;
  while (global.sessionsById.has(sessionId));
  return sessionId;
}

function claimContinuationToken(global: InlineRuntimeGlobal, session: InlineSession): void {
  const owner = global.sessionIdByContinuationToken.get(session.continuationToken);
  if (owner !== undefined && owner !== session.id) {
    throw new Error(
      `Continuation token "${session.continuationToken}" already belongs to session "${owner}".`,
    );
  }
  global.sessionIdByContinuationToken.set(session.continuationToken, session.id);
}

function rekeyContinuationToken(
  global: InlineRuntimeGlobal,
  session: InlineSession,
  nextToken: string,
): void {
  if (!nextToken)
    throw new Error("Cannot park an inline loop session without a continuation token.");
  const nextOwner = global.sessionIdByContinuationToken.get(nextToken);
  if (nextOwner !== undefined && nextOwner !== session.id) {
    throw new Error(`Continuation token "${nextToken}" already belongs to session "${nextOwner}".`);
  }
  global.sessionIdByContinuationToken.delete(session.continuationToken);
  global.sessionIdByContinuationToken.set(nextToken, session.id);
  session.continuationToken = nextToken;
}

function releaseContinuationToken(global: InlineRuntimeGlobal, session: InlineSession): void {
  if (global.sessionIdByContinuationToken.get(session.continuationToken) === session.id) {
    global.sessionIdByContinuationToken.delete(session.continuationToken);
  }
}

function enqueueDelivery(session: InlineSession, delivery: DeliverHookPayload): void {
  const waiter = session.deliveryWaiter;
  if (waiter === undefined) {
    session.pendingDeliveries.push(delivery);
  } else {
    session.deliveryWaiter = undefined;
    waiter(delivery);
  }
}

async function waitForDelivery(session: InlineSession): Promise<DeliverHookPayload> {
  const pending = session.pendingDeliveries.shift();
  if (pending !== undefined) return pending;
  return await new Promise((resolve) => {
    session.deliveryWaiter = resolve;
  });
}
