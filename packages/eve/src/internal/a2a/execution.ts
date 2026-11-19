import { randomUUID } from "node:crypto";

import { isAnonymousPrincipal } from "#channel/principal-identity.js";
import { answerFromText } from "#channel/resolve-text.js";
import type { ChannelResolveSession } from "#channel/channel-operations.js";
import type { AttachSessionFn } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import {
  invocationContinuationToken,
  readOwnedInvocationRun,
} from "#internal/invocation/owned-run.js";
import type { RouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import {
  collectUploadPolicyViolations,
  formatUploadPolicyViolation,
  type UploadPolicy,
} from "#public/channels/upload-policy.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { parseAnswer } from "#shared/input.js";
import type { MessageContent, MessagePart } from "#shared/message-content.js";

import {
  decodePageToken,
  decodeTaskId,
  deliveryIdForMessage,
  encodePageToken,
  messageIdempotencyKey,
  messageIdOfDelivery,
  type TaskRef,
} from "./ids.js";
import {
  A2A_JSON_RPC_ERRORS,
  A2aError,
  isSettledForBlocking,
  isTerminalState,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  type Task,
} from "./protocol.js";
import {
  answerTurnedDown,
  compareContextTasks,
  contextBusy,
  contextTasks,
  followSessionView,
  hasDelivery,
  hasRead,
  openPromptsForTurn,
  projectTask,
  reachedTask,
  readSessionView,
  submittedTask,
  type A2aFailure,
  type ProjectTaskOptions,
} from "./task-projection.js";

export interface A2aExecutionOptions {
  readonly createSession: RouteSessionCreator;
  readonly attachSession: AttachSessionFn;
  readonly resolveSession: ChannelResolveSession;
  readonly maxBlockingMs: number;
  readonly uploadPolicy: UploadPolicy;
  readonly toolActivity: boolean;
  readonly failureText?: (failure: A2aFailure) => string;
}

export interface A2aCallContext {
  readonly auth: SessionAuthContext | null;
  readonly signal: AbortSignal;
}

const ADMISSION_WAIT_MS = 5_000;
const CANCEL_SETTLE_MS = 5_000;
const DEFAULT_PAGE_SIZE = 50;

export class A2aTaskExecution {
  readonly #options: A2aExecutionOptions;

  constructor(options: A2aExecutionOptions) {
    this.#options = options;
  }

  async sendMessage(request: SendMessageRequest, call: A2aCallContext): Promise<Task> {
    const sent = await this.#deliver(request, call);
    const options = this.#projection({ historyLength: request.configuration?.historyLength });
    if (request.configuration?.returnImmediately === true) {
      const view = await readSessionView(sent.ref.sessionId);
      return projectTask(view, reachedRef(view, sent), options);
    }
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(this.#options.maxBlockingMs)]);
    let task: Task | undefined;
    for await (const update of this.#follow(sent, options, signal)) {
      task = update.task;
      if (update.read && isSettledForBlocking(task.status.state)) return task;
    }
    if (task !== undefined) return task;
    return sent.view === undefined
      ? submittedTask(sent.ref)
      : projectTask(sent.view, reachedRef(sent.view, sent), options);
  }

  async streamMessage(
    request: SendMessageRequest,
    call: A2aCallContext,
  ): Promise<AsyncIterable<StreamResponse>> {
    const sent = await this.#deliver(request, call);
    const options = this.#projection({ historyLength: request.configuration?.historyLength });
    return this.#stream(sent, options, call.signal, { closeOnInterrupt: true });
  }

  async subscribe(
    request: SubscribeToTaskRequest,
    call: A2aCallContext,
  ): Promise<AsyncIterable<StreamResponse>> {
    const { ref, view } = await this.#readTask(request.id, call.auth);
    const task = projectTask(view, ref, { historyLength: 0 });
    if (isTerminalState(task.status.state)) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.unsupportedOperation, "Task is already terminal.");
    }
    return this.#stream({ deliveryId: ref.deliveryId, ref }, this.#projection(), call.signal, {
      closeOnInterrupt: false,
    });
  }

  async getTask(request: GetTaskRequest, call: A2aCallContext): Promise<Task> {
    const { ref, view } = await this.#readTask(request.id, call.auth);
    return projectTask(view, ref, this.#projection({ historyLength: request.historyLength }));
  }

  async cancelTask(request: CancelTaskRequest, call: A2aCallContext): Promise<Task> {
    const { ref, view } = await this.#readTask(request.id, call.auth);
    const task = projectTask(view, ref, this.#projection());
    if (isTerminalState(task.status.state)) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.taskNotCancelable, "Task is already terminal.");
    }
    const turnId = view.deliveries[ref.deliveryId]?.turnId;
    if (turnId === undefined) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.taskNotCancelable,
        "Task hasn't started yet; it can be cancelled once it is working.",
      );
    }
    await this.#options.attachSession(ref.sessionId).cancel({ auth: call.auth, turnId });
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(CANCEL_SETTLE_MS)]);
    let latest = task;
    const follow = this.#follow({ deliveryId: ref.deliveryId, ref }, this.#projection(), signal);
    for await (const update of follow) {
      latest = update.task;
      if (isTerminalState(latest.status.state)) break;
    }
    return latest;
  }

  async listTasks(request: ListTasksRequest, call: A2aCallContext): Promise<ListTasksResponse> {
    if (request.contextId === undefined) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.invalidParams,
        "contextId is required: this agent lists the tasks of one context at a time.",
      );
    }
    const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
    const cursor =
      request.pageToken === undefined || request.pageToken === ""
        ? undefined
        : decodePageToken(request.pageToken, request.contextId);
    if (cursor === null) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Invalid pageToken.");
    }
    const empty = { nextPageToken: "", pageSize, tasks: [], totalSize: 0 };
    const run = await readOwnedInvocationRun(request.contextId, call.auth);
    if (run === undefined) return empty;

    const view = await readSessionView(request.contextId);
    const after =
      request.statusTimestampAfter === undefined ? 0 : Date.parse(request.statusTimestampAfter);
    const statusOnly = this.#projection({ historyLength: 0, includeArtifacts: false });
    const matching = contextTasks(view, request.contextId, statusOnly).filter(
      (entry) =>
        (request.status === undefined ||
          request.status === "TASK_STATE_UNSPECIFIED" ||
          entry.task.status.state === request.status) &&
        entry.at >= after,
    );
    const start =
      cursor === undefined
        ? 0
        : matching.findIndex((entry) => compareContextTasks(cursor, entry) < 0);
    const page = start < 0 ? [] : matching.slice(start, start + pageSize);
    const last = page.at(-1);
    const more = start >= 0 && start + pageSize < matching.length;
    return {
      nextPageToken:
        more && last !== undefined ? encodePageToken(request.contextId, last.at, last.seq) : "",
      pageSize,
      tasks: page.map((entry) =>
        projectTask(
          view,
          entry.ref,
          this.#projection({
            historyLength: request.historyLength,
            includeArtifacts: request.includeArtifacts ?? false,
          }),
        ),
      ),
      totalSize: matching.length,
    };
  }

  async #deliver(request: SendMessageRequest, call: A2aCallContext): Promise<SentDelivery> {
    if (request.configuration?.taskPushNotificationConfig !== undefined) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.pushNotificationNotSupported,
        "Push notifications are not supported.",
      );
    }
    const { message } = request;
    if (message.role === "ROLE_AGENT") {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "message.role must be ROLE_USER.");
    }
    const ownerKey = invocationOwnerKey(call.auth);
    const idempotencyKey = messageIdempotencyKey(ownerKey, message.messageId);
    const delivery: DeliveryKeys = {
      deliveryId: deliveryIdForMessage(message.messageId),
      idempotencyKey,
    };
    if (message.taskId !== undefined) return await this.#continueTask(message, call, delivery);
    if (message.contextId !== undefined) {
      return await this.#startTaskInContext(message, message.contextId, call, delivery);
    }
    return await this.#startContext(message, call, ownerKey, delivery);
  }

  async #startContext(
    message: Message,
    call: A2aCallContext,
    ownerKey: string,
    delivery: DeliveryKeys,
  ): Promise<SentDelivery> {
    const content = this.#content(message);
    const anonymous = call.auth === null || isAnonymousPrincipal(call.auth);
    const continuationToken = anonymous
      ? `a2a:anonymous:${randomUUID()}`
      : `a2a:${delivery.idempotencyKey}`;
    if (!anonymous) {
      const existing = await this.#options.resolveSession(continuationToken);
      if (existing !== undefined) {
        return { deliveryId: delivery.deliveryId, ref: refFor(existing.id, delivery) };
      }
    }
    const handle = await this.#options.createSession({
      auth: call.auth,
      capabilities: { requestInput: true },
      continuationToken,
      deliveryId: delivery.deliveryId,
      externalInvocation: { continuationToken, ownerKey },
      idempotencyKey: delivery.idempotencyKey,
      input: { message: content },
    });
    await this.#awaitAdmission(handle.sessionId, delivery.deliveryId, call.signal);
    return { deliveryId: delivery.deliveryId, ref: refFor(handle.sessionId, delivery) };
  }

  async #startTaskInContext(
    message: Message,
    contextId: string,
    call: A2aCallContext,
    delivery: DeliveryKeys,
  ): Promise<SentDelivery> {
    const run = await readOwnedInvocationRun(contextId, call.auth);
    const token = run === undefined ? undefined : invocationContinuationToken(run);
    if (run === undefined || token === undefined) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Unknown contextId.");
    }
    const sent = { deliveryId: delivery.deliveryId, ref: refFor(contextId, delivery) };
    const view = await readSessionView(contextId);
    if (hasDelivery(view, delivery.deliveryId)) return sent;
    if (isEndedRun(run.status)) throw contextEnded();
    if (contextBusy(view, contextId)) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.unsupportedOperation,
        "This context has an unfinished task. Continue it with its taskId, wait for it to " +
          "finish, or start a new context.",
      );
    }
    await this.#options.attachSession(contextId).send(this.#content(message), {
      ...delivery,
      auth: call.auth,
      turnPolicy: "queue",
    } as DeliveryOptions);
    await this.#awaitAdmission(contextId, delivery.deliveryId, call.signal);
    return sent;
  }

  async #awaitAdmission(sessionId: string, deliveryId: string, signal: AbortSignal) {
    const until = AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_WAIT_MS)]);
    try {
      for await (const view of followSessionView(sessionId, until)) {
        if (hasDelivery(view, deliveryId)) return;
      }
    } catch (error) {
      if (!until.aborted) throw error;
    }
  }

  async #continueTask(
    message: Message,
    call: A2aCallContext,
    delivery: DeliveryKeys,
  ): Promise<SentDelivery> {
    const { ref, run, view } = await this.#readTask(message.taskId!, call.auth);
    if (message.contextId !== undefined && message.contextId !== ref.sessionId) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "contextId does not match taskId.");
    }
    const sent: SentDelivery = { deliveryId: delivery.deliveryId, followUp: true, ref, view };
    if (hasDelivery(view, delivery.deliveryId)) return sent;
    const task = projectTask(view, ref, this.#projection({ historyLength: 0 }));
    if (isTerminalState(task.status.state)) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.unsupportedOperation,
        "Task is terminal; send a new message in its context instead.",
      );
    }
    if (isEndedRun(run.status)) throw contextEnded();
    const turnId = view.deliveries[ref.deliveryId]?.turnId;
    if (turnId === undefined) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.unsupportedOperation,
        "Task hasn't started yet; send follow-ups once it is working.",
      );
    }
    const answering = isSettledForBlocking(task.status.state)
      ? { ...sent, answering: statusKey(task) }
      : sent;

    if (task.status.state === "TASK_STATE_INPUT_REQUIRED") {
      const answer = this.#answerFor(view, turnId, message);
      await this.#options.attachSession(ref.sessionId).respond([parseAnswer(answer)], {
        ...delivery,
        auth: call.auth,
      } as RespondOptions);
      return answering;
    }

    await this.#options.attachSession(ref.sessionId).send(this.#content(message), {
      ...delivery,
      auth: call.auth,
      turnPolicy: "steer",
    } as DeliveryOptions);
    return answering;
  }

  #projection(options: ProjectTaskOptions = {}): ProjectTaskOptions {
    return {
      ...options,
      toolActivity: this.#options.toolActivity,
      ...(this.#options.failureText !== undefined && { failureText: this.#options.failureText }),
    };
  }

  #answerFor(view: SessionView, turnId: string, message: Message) {
    const prompt = openPromptsForTurn(view, turnId).find((row) => row.request.kind !== "sign-in");
    if (prompt === undefined) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Task has no open question.");
    }
    if (message.parts.some((part) => part.text === undefined)) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.invalidParams,
        "Answer an open question with text parts only.",
      );
    }
    const text = message.parts.map((part) => part.text).join("\n");
    const answer = answerFromText(text, prompt);
    if (answer === undefined) {
      const options = (prompt.request.options ?? []).map(
        (option, index) => `${index + 1}. ${option.label}`,
      );
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.invalidParams,
        `The answer matches none of the question's options. Reply with one of: ${options.join(", ")}.`,
      );
    }
    return answer;
  }

  async #readTask(taskId: string, auth: SessionAuthContext | null) {
    const ref = decodeTaskId(taskId);
    if (ref === undefined || messageIdOfDelivery(ref.deliveryId) === undefined) {
      throw A2aError.taskNotFound();
    }
    const run = await readOwnedInvocationRun(ref.sessionId, auth);
    const token = run === undefined ? undefined : invocationContinuationToken(run);
    if (run === undefined || token === undefined) throw A2aError.taskNotFound();
    const view = await readSessionView(ref.sessionId);
    if (view.deliveries[ref.deliveryId] === undefined && view.session.status === "ended") {
      throw A2aError.taskNotFound();
    }
    return { ref, run, view };
  }

  #content(message: Message): MessageContent {
    const content = toMessageContent(message);
    const [violation] = collectUploadPolicyViolations(content, this.#options.uploadPolicy);
    if (violation !== undefined) {
      throw new A2aError(
        violation.kind === "disallowed-media-type"
          ? A2A_JSON_RPC_ERRORS.contentTypeNotSupported
          : A2A_JSON_RPC_ERRORS.invalidParams,
        formatUploadPolicyViolation(violation),
      );
    }
    return content;
  }

  async *#follow(
    sent: SentDelivery,
    options: ProjectTaskOptions,
    signal: AbortSignal,
  ): AsyncGenerator<{ readonly task: Task; readonly read: boolean }, void, undefined> {
    try {
      for await (const view of followSessionView(sent.ref.sessionId, signal)) {
        const ref = reachedRef(view, sent);
        const task = projectTask(view, ref, options);
        const read =
          hasRead(view, sent.deliveryId) &&
          (sent.answering === undefined ||
            ref !== sent.ref ||
            statusKey(task) !== sent.answering ||
            answerTurnedDown(view, sent.deliveryId));
        yield { read, task };
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async *#stream(
    sent: SentDelivery,
    options: ProjectTaskOptions,
    signal: AbortSignal,
    mode: { readonly closeOnInterrupt: boolean },
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const contextId = sent.ref.sessionId;
    let last: string | undefined;
    let taskId: string | undefined;
    for await (const { read, task } of this.#follow(sent, options, signal)) {
      const key = statusKey(task);
      if (last === undefined || task.id !== taskId) {
        taskId = task.id;
        yield { task };
      } else if (key !== last) {
        if (task.status.state === "TASK_STATE_COMPLETED") {
          for (const artifact of task.artifacts ?? []) {
            yield {
              artifactUpdate: { artifact, contextId, lastChunk: true, taskId: task.id },
            };
          }
        }
        yield { statusUpdate: { contextId, status: task.status, taskId: task.id } };
      }
      last = key;
      const state = task.status.state;
      if (isTerminalState(state) && (sent.followUp !== true || read)) return;
      if (mode.closeOnInterrupt && read && isSettledForBlocking(state)) return;
    }
  }
}

interface DeliveryKeys {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
}

interface SentDelivery {
  readonly ref: TaskRef;
  readonly deliveryId: string;
  readonly followUp?: boolean;
  readonly answering?: string;
  readonly view?: SessionView;
}

function reachedRef(view: SessionView, sent: SentDelivery): TaskRef {
  return sent.followUp === true ? reachedTask(view, sent.ref, sent.deliveryId) : sent.ref;
}

type DeliveryOptions = Parameters<Session["send"]>[1] & NamedDelivery;
type RespondOptions = Parameters<Session["respond"]>[1] & NamedDelivery;

interface NamedDelivery {
  readonly deliveryId: string;
}

function refFor(sessionId: string, delivery: DeliveryKeys): TaskRef {
  return { deliveryId: delivery.deliveryId, sessionId };
}

function isEndedRun(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function contextEnded(): A2aError {
  return new A2aError(
    A2A_JSON_RPC_ERRORS.unsupportedOperation,
    "This context has ended; send the message without a contextId to start a new one.",
  );
}

function statusKey(task: Task): string {
  const { timestamp: _timestamp, ...status } = task.status;
  return JSON.stringify(status);
}

export function toMessageContent(message: Message): MessageContent {
  const parts = message.parts.map((part): MessagePart => {
    if (part.text !== undefined) return { text: part.text, type: "text" };
    if (part.raw !== undefined || part.url !== undefined) {
      const data = (part.raw ?? part.url)!;
      if (hasInternalRefScheme(data)) {
        throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Unsupported file URL.");
      }
      const file: MessagePart = {
        data,
        mediaType: part.mediaType ?? "application/octet-stream",
        type: "file",
      };
      return part.filename === undefined ? file : { ...file, filename: part.filename };
    }
    return { text: JSON.stringify(part.data), type: "text" };
  });
  const only = parts[0];
  return parts.length === 1 && only?.type === "text" ? only.text : parts;
}
