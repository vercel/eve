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
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import {
  invocationContinuationToken,
  readOwnedInvocationRun,
} from "#internal/invocation/owned-run.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import {
  emptyPreviews,
  emptySessionView,
  foldReceivedEvent,
} from "#protocol/session-projection/fold.js";
import { openRequests, openSignIns, interaction } from "#protocol/session-projection/reader.js";
import {
  activity,
  failure,
  interactionBatches,
  reply,
  replyText,
} from "#protocol/session-projection/selectors.js";
import type {
  InteractionRow,
  SessionPreviews,
  SessionView,
} from "#protocol/session-projection/tables.js";
import { reasoningStatus } from "#channel/reasoning-status.js";
import { truncate } from "#public/channels/text.js";
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

    const run = await readOwnedInvocationRun(handle.sessionId, input.auth);
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
    const run = await readOwnedInvocationRun(input.invocationId, input.auth);
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
      token: invocationContinuationToken(run),
    };
  }
}

type InputBatch = ReadonlyMap<string, Interaction>;

interface InvocationFailure {
  readonly error: ErrorInfo;
  readonly terminal: boolean;
}

interface InvocationStream {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
  readonly batches: readonly InputBatch[];
  readonly pending: InputBatch | undefined;
  readonly signIns: readonly InteractionRow[];
  readonly result: JsonValue | undefined;
  readonly settled: "completed" | "cancelled" | InvocationFailure | undefined;
}

async function readInvocationStream(invocationId: string): Promise<InvocationStream> {
  const view = emptySessionView();
  const previews = emptyPreviews();
  const reader = createEventReader();
  for await (const { line, position, record } of streamSessionLines(invocationId, {
    follow: false,
  })) {
    if (line === undefined) {
      if (position === 0 && isV26Line(record)) return startedOnEarlierEve(view);
      continue;
    }
    for (const event of reader.read(line, position)) foldReceivedEvent(view, event, previews);
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
    previews,
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
    previews: emptyPreviews(),
    result: undefined,
    settled: { error, terminal: true },
    signIns: [],
    view,
  };
}

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
  return {
    ...info,
    pollAfterMs: 1_000,
    result,
    status: "working",
    statusMessage: statusMessage(stream.view, stream.previews),
  };
}

const WRITING_REPLY_MIN_CHARS = 280;
const STATUS_MESSAGE_MAX_LENGTH = 200;

function statusMessage(view: SessionView, previews: SessionPreviews): string | undefined {
  const current = activity(view);
  if (current.kind === "calling") return latestOf(current.names);
  if (current.kind === "waiting-on-tasks") return latestOf(current.tasks.map((task) => task.name));
  if (current.kind !== "thinking") return undefined;
  const turnId = view.session.latestTurnId;
  const streaming = Object.values(previews.parts).filter((part) => partTurn(view, part) === turnId);
  const replyChars = streaming
    .filter((part) => part.kind === "text")
    .reduce((total, part) => total + part.text.length, 0);
  const replied = turnId !== undefined && (view.turns[turnId]?.reply?.length ?? 0) > 0;
  if (replied || replyChars >= WRITING_REPLY_MIN_CHARS) return "Writing a reply...";
  const live = streaming.findLast((part) => part.kind === "reasoning");
  const done = Object.values(view.parts).findLast(
    (part) =>
      part.kind === "reasoning" &&
      typeof part.value === "string" &&
      partTurn(view, part) === turnId,
  );
  const maxLength = STATUS_MESSAGE_MAX_LENGTH;
  const reasoning =
    (live === undefined ? undefined : reasoningStatus(live.text, { maxLength })) ??
    (typeof done?.value === "string"
      ? reasoningStatus(done.value, { complete: true, maxLength })
      : undefined);
  return reasoning === undefined ? "Thinking..." : truncate(reasoning, STATUS_MESSAGE_MAX_LENGTH);
}

function latestOf(names: readonly string[]): string | undefined {
  const latest = names.at(-1);
  if (latest === undefined) return undefined;
  return names.length === 1 ? latest : `${latest} (+${String(names.length - 1)} more)`;
}

function partTurn(
  view: SessionView,
  part: { readonly runId?: string; readonly turnId?: string },
): string | undefined {
  if (part.turnId !== undefined) return part.turnId;
  const owner = part.runId === undefined ? undefined : view.runs[part.runId]?.owner;
  return owner !== undefined && "turnId" in owner ? owner.turnId : undefined;
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
