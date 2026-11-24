import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
import {
  opaque,
  sessionAddress,
  type DeliveryAddress,
  type DeliveryResult,
  type Durable,
} from "#execution/durable.js";
import { prepareInitialEntry, type PreparedInitialEntry } from "#execution/initial-entry.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import type { StreamHosts } from "#execution/hosts.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { SessionPredecessor } from "#protocol/session-events/families/session.js";
import { runtimeNodeId } from "#runtime/sessions/session-agent.js";

export interface SessionStartBody {
  readonly entry: PreparedInitialEntry["entry"];
  readonly nodeId: string;
  readonly externalInvocation?: RunInput["externalInvocation"];
}

type Stranded = Extract<DeliveryResult, { readonly reason: "stranded" }>;

const CONTINUATION_START_ATTEMPTS = 3;

export function sessionStrandedError(
  eveVersion: string | undefined,
  nextStep?: string,
): SessionStrandedError {
  const owner = eveVersion === undefined ? {} : { eveVersion };
  return new SessionStrandedError(owner, describeStrandedSession(owner, nextStep));
}

function sessionHandle(
  hosts: StreamHosts,
  sessionId: string,
  deliveryId: string | undefined,
  claimedContinuation?: boolean,
): RunHandle {
  let events: ReadableStream<SessionStreamEvent> | undefined;
  return {
    get events() {
      events ??= readSessionEventStream(hosts, sessionId);
      return events;
    },
    sessionId,
    ...(deliveryId !== undefined && { deliveryId }),
    ...(claimedContinuation !== undefined && { claimedContinuation }),
  };
}

export function sessionRuntime(
  durable: Durable,
  hosts: StreamHosts,
  config: SessionRuntimeConfig,
): Runtime {
  const startSession = async (
    input: RunInput,
    predecessor?: SessionPredecessor,
    attempt = 0,
  ): Promise<RunHandle> => {
    const prepared = await prepareInitialEntry(config, input, predecessor);
    input = prepared.input;
    const { continuationToken } = input;
    const hasContinuation = continuationToken !== undefined && continuationToken !== "";
    const body: SessionStartBody = {
      entry: prepared.entry,
      nodeId: runtimeNodeId(prepared.agent),
      ...(input.externalInvocation !== undefined && {
        externalInvocation: input.externalInvocation,
      }),
    };
    const started = await durable.start({
      addresses: hasContinuation ? [sessionAddress(continuationToken)] : [],
      body: opaque(body),
    });
    if (started.kind === "held") return await joinContinuationOwner(input, predecessor, attempt);
    return sessionHandle(
      hosts,
      started.sessionId,
      input.delivery?.deliveryId,
      hasContinuation ? true : undefined,
    );
  };

  const joinContinuationOwner = async (
    input: RunInput & { readonly continuationToken?: string },
    predecessor: SessionPredecessor | undefined,
    attempt: number,
  ): Promise<RunHandle> => {
    const continuationToken = input.continuationToken ?? "";
    const command = input.continuationConflictCommand;
    let owner: string | undefined;
    if (command === undefined) {
      owner = (await resolveContinuation(continuationToken))?.sessionId;
    } else {
      const result = await dispatchContinuation({ command, continuationToken, successor: input });
      if (result.status === "accepted") owner = result.sessionId;
    }
    if (owner !== undefined) return sessionHandle(hosts, owner, input.delivery?.deliveryId, false);
    if (attempt + 1 >= CONTINUATION_START_ATTEMPTS)
      throw new SessionNotActiveError({ retryable: true });
    return await startSession(input, predecessor, attempt + 1);
  };

  const dispatchContinuation = async <TCommand extends SessionCommand>(
    input: DispatchContinuationInput<TCommand>,
  ): Promise<SessionCommandResult<TCommand>> => {
    const { continuationToken, successor } = input;
    const command = identifyCommand(input.command);
    const dispatched = await dispatchCommand(durable, sessionAddress(continuationToken), command);
    if (dispatched.kind === "result") return dispatched.result;
    const { stranded } = dispatched;
    if (command.kind !== "send" || successor === undefined) {
      return await settleStrandedCommand(command, stranded);
    }
    if ((command.payload.answers?.length ?? 0) > 0) {
      throw sessionStrandedError(
        stranded.eveVersion,
        "Its pending requests can no longer be answered; send a new message to start a fresh session.",
      );
    }
    const previousSessionId = await stranded.end();
    const started = await startSession(
      { ...successor, delivery: command.delivery },
      { sessionId: previousSessionId },
    );
    return {
      sessionId: started.sessionId,
      deliveryId: command.delivery?.deliveryId,
      status: "accepted",
    } as SessionCommandResult<TCommand>;
  };

  const resolveContinuation: Runtime["resolveContinuation"] = async (
    continuationToken,
    options,
  ) => {
    const sessionId = await durable.sessionFor(sessionAddress(continuationToken), options);
    return sessionId === undefined ? undefined : { sessionId };
  };

  const followable = async (sessionId: string): Promise<void> => {
    await durable.assertFollowable?.(sessionId);
  };
  const { hasRunnableOwner, readChildBinding } = durable;

  return {
    createSession: (input) => startSession(input),
    dispatchContinuation,
    dispatchSession: (input) => dispatchSessionCommand(durable, input),
    resolveContinuation,
    async getEventStream(sessionId, options) {
      if (options?.follow === false)
        return readSessionEventHistory(hosts, sessionId, options.startIndex, options.signal);
      await followable(sessionId);
      return readSessionEventStream(hosts, sessionId, options?.startIndex, options?.signal);
    },
    async getLineStream(sessionId, options) {
      if (options?.follow === false)
        return readSessionRecordHistory(hosts, sessionId, options.startIndex);
      const records = readSessionRecords(hosts, sessionId, options?.startIndex);
      try {
        await followable(sessionId);
      } catch (error) {
        await records.cancel().catch(() => {});
        throw error;
      }
      return records;
    },
    getStreamTailIndex: (sessionId) => readSessionStreamTailIndex(hosts, sessionId),
    ...(readChildBinding !== undefined && {
      readChildBinding: (sessionId: string, childSessionId: string) =>
        readChildBinding(sessionId, childSessionId),
    }),
    ...(hasRunnableOwner !== undefined && {
      hasRunnableOwner: (sessionId: string) => hasRunnableOwner(sessionId),
    }),
  };
}

export async function dispatchSessionCommand<TCommand extends SessionCommand>(
  durable: Durable,
  input: DispatchSessionInput<TCommand>,
): Promise<SessionCommandResult<TCommand>> {
  const command = identifyCommand(input.command);
  const dispatched = await dispatchCommand(
    durable,
    sessionAddress({ sessionId: input.sessionId, inbox: input.inbox }),
    command,
  );
  return dispatched.kind === "result"
    ? dispatched.result
    : await settleStrandedCommand(command, dispatched.stranded);
}

type Dispatched<TCommand extends SessionCommand> =
  | { readonly kind: "result"; readonly result: SessionCommandResult<TCommand> }
  | { readonly kind: "stranded"; readonly stranded: Stranded };

async function dispatchCommand<TCommand extends SessionCommand>(
  durable: Durable,
  address: DeliveryAddress,
  command: TCommand,
): Promise<Dispatched<TCommand>> {
  if (command.kind === "prewarm" && durable.prewarm !== undefined) {
    const prewarmed = await durable.prewarm(address, command.targetDeploymentId);
    return { kind: "result", result: prewarmed as SessionCommandResult<TCommand> };
  }
  const delivered = await durable.deliver(address, command);
  if (!delivered.accepted) {
    return delivered.reason === "stranded"
      ? { kind: "stranded", stranded: delivered }
      : { kind: "result", result: inactiveCommandResult(command) };
  }
  if (delivered.sessionId === undefined) {
    throw new Error("The durable engine accepted a session command without naming its session.");
  }
  const result = activeCommandResult(command, delivered.sessionId);
  return {
    kind: "result",
    result: (result.status === "accepted" && "inbox" in delivered
      ? { ...result, inbox: delivered.inbox }
      : result) as SessionCommandResult<TCommand>,
  };
}

async function settleStrandedCommand<TCommand extends SessionCommand>(
  command: TCommand,
  stranded: Stranded,
): Promise<SessionCommandResult<TCommand>> {
  switch (command.kind) {
    case "reset":
      return {
        previousSessionId: await stranded.end(),
        status: "reset",
      } as SessionCommandResult<TCommand>;
    case "send":
    case "clear":
      throw sessionStrandedError(stranded.eveVersion);
    default:
      return inactiveCommandResult(command);
  }
}
