import { interactionJson } from "#protocol/interaction-json.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { MessageContent } from "#shared/message-content.js";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import type { ChannelFrom } from "#channel/channel-operations.js";
import { streamSessionLines } from "#execution/session-event-stream.js";
import { createEventReader } from "#protocol/session-lines.js";
import { isV26Line } from "#protocol/v26-lines.js";
import type {
  AgentInvocation,
  AgentInvocationInteraction,
  AgentInvocationInteractions,
  AgentInvocationMutationResult,
  AgentInvocationStatus,
} from "#internal/invocation/agent-invocation.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openRequests, openSignIns, interaction } from "#protocol/session-projection/reader.js";
import {
  failure,
  interactionBatches,
  reply,
  replyText,
} from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import { type Answer, parseAnswers } from "#shared/input.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { JsonValue } from "#shared/json.js";

export class WorkflowAgentInvocationExecution {
  readonly #createSession: RouteSessionCreator;
  readonly #from: ChannelFrom;

  constructor(input: { readonly createSession: RouteSessionCreator; readonly from: ChannelFrom }) {
    this.#createSession = input.createSession;
    this.#from = input.from;
  }

  async create(input: {
    readonly auth: SessionAuthContext | null;
    readonly message: MessageContent;
  }): Promise<AgentInvocation> {
    const continuationToken = `invocation:${crypto.randomUUID()}`;
    const handle = await this.#createSession({
      auth: input.auth,
      capabilities: { requestInput: true },
      continuationToken,
      externalInvocation: {
        continuationToken,
        ownerKey: invocationOwnerKey(input.auth),
      },
      input: { message: input.message },
    });

    const run = await this.#readInvocationRun(handle.sessionId, input.auth);
    if (run === undefined) {
      throw new Error("Invocation run was unavailable after durable creation.");
    }
    return workingInvocation(
      handle.sessionId,
      run.createdAt.toISOString(),
      run.expiredAt?.toISOString(),
    );
  }

  async read(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    return (await this.#readCurrent(input))?.invocation;
  }

  async update(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
    readonly responses: readonly Answer[];
  }): Promise<AgentInvocationMutationResult> {
    const current = await this.#readCurrent(input);
    if (current === undefined) return { type: "not_found" };
    const { invocation, stream, token } = current;
    const pendingBatch = stream?.pending;
    if (invocation.status !== "awaiting-input" || pendingBatch === undefined) {
      // A retry after a lost response is the common case here: the answer
      // already landed, so acknowledge it instead of demanding a new one.
      if (stream !== undefined && replaysSettledBatch(stream, input.responses)) {
        return { invocation, type: "success" };
      }
      return conflict("Invocation is not waiting for input.");
    }
    const responseIds = new Set<string>();
    const deliveredResponses: Answer[] = [];
    for (const response of input.responses) {
      const request = pendingBatch.get(response.interactionId);
      if (request === undefined) {
        return conflict(`Unknown input request: ${response.interactionId}`);
      }
      responseIds.add(response.interactionId);
      deliveredResponses.push(response);
    }
    if (responseIds.size !== input.responses.length || responseIds.size !== pendingBatch.size) {
      return conflict("Responses must answer the complete pending input batch exactly once.");
    }
    if (token === undefined) return { type: "not_found" };
    try {
      await this.#from(token).respond(parseAnswers(deliveredResponses), {
        auth: input.auth,
      });
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      throw error;
    }

    return {
      invocation: workingInvocation(input.invocationId, invocation.createdAt, invocation.expiresAt),
      type: "success",
    };
  }

  async cancel(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const current = await this.#readCurrent(input);
    if (current === undefined) return undefined;
    if (isTerminal(current.invocation.status)) return current.invocation;
    if (current.token === undefined) return undefined;
    try {
      await this.#from(current.token).cancel({ auth: input.auth });
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
    return await this.read(input);
  }

  async #readCurrent(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<
    | {
        readonly invocation: AgentInvocation;
        readonly stream?: InvocationStream;
        readonly token?: string;
      }
    | undefined
  > {
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return undefined;
    const base = {
      createdAt: run.createdAt.toISOString(),
      expiresAt: run.expiredAt?.toISOString(),
      invocationId: run.runId,
    };
    if (run.status === "cancelled")
      return { invocation: { ...base, sessionEnded: true, status: "cancelled" } };
    const stream = await readInvocationStream(input.invocationId);
    return {
      invocation: projectInvocation(base, run.status, stream),
      stream,
      token: run.attributes[INVOCATION_TOKEN_ATTRIBUTE],
    };
  }

  async #readInvocationRun(invocationId: string, auth: SessionAuthContext | null) {
    const world = await getWorld();
    try {
      const run = await world.runs.get(invocationId);
      if (run.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
      return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth)
        ? run
        : undefined;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
  }
}

/**
 * The requests one commit opened, by `interactionId`. An id belongs to one interaction for the
 * session's life, so an answer naming one outside the pending batch can't reach a later one.
 */
type InputBatch = ReadonlyMap<string, Interaction>;

interface InvocationFailure {
  readonly error: ErrorInfo;
  readonly terminal: boolean;
}

/** The session's shared tables, plus what an invocation shows that they don't keep. */
interface InvocationStream {
  readonly view: SessionView;
  /** The batches in the order they were requested, each holding the requests it introduced. */
  readonly batches: readonly InputBatch[];
  /** The latest batch with requests still open, narrowed to them. */
  readonly pending: InputBatch | undefined;
  /** Each sign-in still open, in the order they opened. */
  readonly signIns: readonly InteractionRow[];
  /** The latest turn's final message. */
  readonly result: JsonValue | undefined;
  /** How the latest turn ended; reset when a turn starts or a park resumes. */
  readonly settled: "completed" | "cancelled" | InvocationFailure | undefined;
}

async function readInvocationStream(invocationId: string): Promise<InvocationStream> {
  const view = emptySessionView();
  const reader = createEventReader();
  for await (const { line, position, record } of streamSessionLines(invocationId, {
    follow: false,
  })) {
    if (line === undefined) {
      // v27 can't read the turns or requests of an invocation an earlier eve started; without
      // this, it would read as working forever.
      if (position === 0 && isV26Line(record)) return startedOnEarlierEve(view);
      continue;
    }
    for (const event of reader.read(line, position)) foldReceivedEvent(view, event);
  }
  const batches = interactionBatches(view).map(
    (batch): InputBatch =>
      new Map(
        batch.flatMap((row) => {
          const asked = interaction(view, row.interactionId);
          return asked === undefined ? [] : [[row.interactionId, asked] as const];
        }),
      ),
  );
  const open = new Set(openRequests(view).map((row) => row.interactionId));
  const pending = batches
    .map((batch) => new Map([...batch].filter(([id]) => open.has(id))))
    .findLast((batch) => batch.size > 0);
  return {
    batches,
    pending,
    result: latestResult(view),
    settled: howItSettled(view),
    signIns: openSignIns(view),
    view,
  };
}

function startedOnEarlierEve(view: SessionView): InvocationStream {
  const error: ErrorInfo = {
    code: "session_version_unsupported",
    hint: "Start a new invocation.",
    message:
      "This invocation was started on an earlier eve version, and this deployment can't read it.",
  };
  return {
    batches: [],
    pending: undefined,
    result: undefined,
    settled: { error, terminal: true },
    signIns: [],
    view,
  };
}

/**
 * How the latest turn ended, unless an answer it waited on has settled since; a failed session
 * ends the invocation for good.
 */
function howItSettled(view: SessionView): InvocationStream["settled"] {
  const { session } = view;
  const ended = session.outcome === "failed" ? failure(view) : undefined;
  if (ended !== undefined) return { error: ended, terminal: true };
  const turn = session.latestTurnId === undefined ? undefined : view.turns[session.latestTurnId];
  const closedAt = turn?.closedAt ?? Infinity;
  const resumed =
    session.status !== "ended" &&
    Object.values(view.interactions).some((row) => (row.closedAt ?? -1) > closedAt);
  if (turn?.status === "settled" && !resumed) {
    const error = turn.outcome === "failed" ? failure(view, turn.turnId) : undefined;
    if (error !== undefined) return { error, terminal: false };
    return turn.outcome === "cancelled" ? "cancelled" : "completed";
  }
  return session.status === "ended" ? "completed" : undefined;
}

/** What the latest turn replied once it settled: its structured result, or else its text. */
function latestResult(view: SessionView): JsonValue | undefined {
  const turnId = view.session.latestTurnId;
  if (turnId === undefined || view.turns[turnId]?.status !== "settled") return undefined;
  const structured = reply(view, turnId).find((part) => part.kind === "result");
  return structured !== undefined ? structured.value : replyText(view, turnId);
}

function invocationInteractions(
  entries: Iterable<readonly [string, Interaction | undefined]>,
): AgentInvocationInteractions {
  const shown: Record<string, AgentInvocationInteraction> = {};
  for (const [id, asked] of entries) if (asked !== undefined) shown[id] = interactionJson(asked);
  return shown;
}

/** True when `responses` exactly repeats the answers eve accepted for the latest batch. */
function replaysSettledBatch(stream: InvocationStream, responses: readonly Answer[]): boolean {
  const batch = stream.batches.at(-1);
  if (batch === undefined || responses.length !== batch.size) return false;
  const seen = new Set<string>();
  for (const response of responses) {
    const { interactionId } = response;
    if (!batch.has(interactionId) || seen.has(interactionId)) return false;
    seen.add(interactionId);
    const input = interaction(stream.view, interactionId);
    if (input?.status !== "settled" || input.answer === undefined) return false;
    if (input.answer.optionId !== response.optionId || input.answer.text !== response.text) {
      return false;
    }
  }
  return true;
}

/**
 * Projects the invocation from its session. The session parks after the
 * turn settles, so `turn.settled` or a failure — not the run
 * status — is what completes the invocation. An open sign-in or input
 * request outranks how the turn ended.
 */
function projectInvocation(
  base: { readonly createdAt: string; readonly expiresAt?: string; readonly invocationId: string },
  runStatus: string,
  stream: InvocationStream,
): AgentInvocation {
  const { result, settled } = stream;
  const info = {
    ...base,
    sessionEnded:
      stream.view.session.status === "ended" || runStatus === "completed" || runStatus === "failed",
  };
  const failure = typeof settled === "object" ? settled : undefined;
  const failed = (): AgentInvocation => ({
    ...info,
    error: publicInvocationFailure(base.invocationId, failure?.error),
    status: "failed",
  });
  // A pending batch can outlive its session (timeout, failure); nobody can answer it then.
  if (runStatus === "failed" || failure?.terminal === true) return failed();
  if (info.sessionEnded) {
    if (failure !== undefined) return failed();
    return { ...info, result, status: settled === "cancelled" ? "cancelled" : "completed" };
  }
  if (stream.pending !== undefined || stream.signIns.length > 0) {
    const interactions = invocationInteractions([
      ...(stream.pending ?? []),
      ...stream.signIns.map(
        (row) => [row.interactionId, interaction(stream.view, row.interactionId)] as const,
      ),
    ]);
    return { ...info, interactions, pollAfterMs: 1_000, result, status: "awaiting-input" };
  }
  if (failure !== undefined) return failed();
  if (settled === "cancelled") return { ...info, status: "cancelled" };
  if (settled === "completed") return { ...info, result, status: "completed" };
  return { ...info, pollAfterMs: 1_000, result, status: "working" };
}

function workingInvocation(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
): AgentInvocation {
  return {
    createdAt,
    expiresAt,
    invocationId,
    sessionEnded: false,
    pollAfterMs: 1_000,
    status: "working",
  };
}

function publicInvocationFailure(
  runId: string,
  error: ErrorInfo | undefined,
): Extract<AgentInvocation, { readonly status: "failed" }>["error"] {
  const data: Record<string, string> = { runId };
  const deploymentId = vercelDeploymentId();
  if (deploymentId !== undefined) data.vercelDeploymentId = deploymentId;
  if (error !== undefined) {
    data.eveCode = error.code;
    if (error.id !== undefined) data.errorId = error.id;
    if (error.hint !== undefined) data.hint = error.hint;
  }
  return { code: -32603, data, message: error?.message ?? "Invocation failed." };
}

function vercelDeploymentId(): string | undefined {
  if (process.env.VERCEL !== "1") return undefined;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  return deploymentId && deploymentId.length > 0 ? deploymentId : undefined;
}

function conflict(message: string): AgentInvocationMutationResult {
  return { message, type: "conflict" };
}

function isTerminal(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
