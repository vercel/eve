/**
 * A2A task operations over eve sessions.
 *
 * Mapping (see research/a2a-channel.md):
 * - no `contextId`, no `taskId`  -> create an owner-bound session (a new context) and its first task
 * - `contextId` only             -> a new task in that session, queued behind any running turn
 * - `taskId` of a live task      -> join the task's turn: steer it while working, answer it while
 *                                  interrupted (typed text, or eve's interactions data part)
 *
 * Every message is delivered under an idempotency key derived from its owner and `messageId`, and
 * as a delivery ID derived from that key, so a retried message is the same delivery and the same
 * task, never a second one.
 */
import type { ChannelFrom, ChannelResolveSession } from "#channel/channel-operations.js";
import { deliveryIdForIdempotencyKey } from "#channel/delivery-idempotency.js";
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
import type { MessageContent, MessagePart } from "#shared/message-content.js";

import {
  decodePageToken,
  decodeTaskId,
  encodePageToken,
  messageIdempotencyKey,
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
  compareContextTasks,
  contextTasks,
  followSessionView,
  hasDelivery,
  hasRead,
  projectTask,
  readSessionView,
  type ProjectTaskOptions,
} from "./task-projection.js";

export interface A2aExecutionOptions {
  readonly createSession: RouteSessionCreator;
  readonly from: ChannelFrom;
  readonly resolveSession: ChannelResolveSession;
  /** Upper bound on a blocking `SendMessage` wait; then the current state returns. */
  readonly maxBlockingMs: number;
  readonly uploadPolicy: UploadPolicy;
}

/** Who is calling, and what the request carries beside its params. */
export interface A2aCallContext {
  readonly auth: SessionAuthContext | null;
  /** Aborts when the client goes away. */
  readonly signal: AbortSignal;
}

/** How long `CancelTask` waits for the cancelled turn to settle before answering. */
const CANCEL_SETTLE_MS = 5_000;
const DEFAULT_PAGE_SIZE = 50;

export class A2aTaskExecution {
  readonly #options: A2aExecutionOptions;

  constructor(options: A2aExecutionOptions) {
    this.#options = options;
  }

  /**
   * `SendMessage`. Blocking (the default) waits until the session has read the message and the
   * task is terminal or interrupted, up to `maxBlockingMs`; past that the working task returns
   * and the client polls `GetTask` or subscribes.
   */
  async sendMessage(request: SendMessageRequest, call: A2aCallContext): Promise<Task> {
    const sent = await this.#deliver(request, call);
    const options = { historyLength: request.configuration?.historyLength };
    if (request.configuration?.returnImmediately === true) {
      return projectTask(await readSessionView(sent.ref.sessionId), sent.ref, options);
    }
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(this.#options.maxBlockingMs)]);
    let task: Task | undefined;
    for await (const update of this.#follow(sent, options, signal)) {
      task = update.task;
      if (update.read && isSettledForBlocking(task.status.state)) return task;
    }
    return task ?? projectTask(await readSessionView(sent.ref.sessionId), sent.ref, options);
  }

  /**
   * `SendStreamingMessage`. Delivers before the stream opens, so a refused message is an ordinary
   * JSON-RPC error; the stream then follows the task to a terminal or interrupted state.
   */
  async streamMessage(
    request: SendMessageRequest,
    call: A2aCallContext,
  ): Promise<AsyncIterable<StreamResponse>> {
    const sent = await this.#deliver(request, call);
    const options = { historyLength: request.configuration?.historyLength };
    return this.#stream(sent, options, call.signal, { closeOnInterrupt: true });
  }

  /** `SubscribeToTask`: the task now, then its changes until it is terminal. */
  async subscribe(
    request: SubscribeToTaskRequest,
    call: A2aCallContext,
  ): Promise<AsyncIterable<StreamResponse>> {
    const { ref } = await this.#ownedTask(request.id, call.auth);
    const task = projectTask(await readSessionView(ref.sessionId), ref, { historyLength: 0 });
    if (isTerminalState(task.status.state)) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.unsupportedOperation, "Task is already terminal.");
    }
    return this.#stream({ deliveryId: ref.deliveryId, ref }, {}, call.signal, {
      closeOnInterrupt: false,
    });
  }

  async getTask(request: GetTaskRequest, call: A2aCallContext): Promise<Task> {
    const { ref } = await this.#ownedTask(request.id, call.auth);
    return projectTask(await readSessionView(ref.sessionId), ref, {
      historyLength: request.historyLength,
    });
  }

  /**
   * `CancelTask`: cooperatively cancels the task's turn, then waits briefly for it to settle so
   * the answer usually reads `CANCELED`.
   */
  async cancelTask(request: CancelTaskRequest, call: A2aCallContext): Promise<Task> {
    const { ref, token } = await this.#ownedTask(request.id, call.auth);
    const view = await readSessionView(ref.sessionId);
    const task = projectTask(view, ref);
    if (isTerminalState(task.status.state)) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.taskNotCancelable, "Task is already terminal.");
    }
    const turnId = view.deliveries[ref.deliveryId]?.turnId;
    // A SUBMITTED task's message may be queued behind another task's turn. Cancelling the running
    // turn would stop that other task, and eve can't withdraw a queued message.
    if (turnId === undefined) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.taskNotCancelable,
        "Task hasn't started yet; it can be cancelled once it is working.",
      );
    }
    await this.#options.from(token).cancel({ auth: call.auth, turnId });
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(CANCEL_SETTLE_MS)]);
    let latest = task;
    for await (const update of this.#follow({ deliveryId: ref.deliveryId, ref }, {}, signal)) {
      latest = update.task;
      if (isTerminalState(latest.status.state)) break;
    }
    return latest;
  }

  /**
   * `ListTasks` for one context, newest status first. Listing across contexts would need an index
   * of each caller's sessions, which eve doesn't keep, so `contextId` is required.
   */
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
    const options: ProjectTaskOptions = {
      historyLength: request.historyLength,
      includeArtifacts: request.includeArtifacts ?? false,
    };
    const after =
      request.statusTimestampAfter === undefined ? 0 : Date.parse(request.statusTimestampAfter);
    const matching = contextTasks(view, request.contextId, options).filter(
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
      tasks: page.map((entry) => entry.task),
      totalSize: matching.length,
    };
  }

  // -------------------------------------------------------------------------------------------

  /** Validates and delivers a message, returning the task it reached. */
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
      deliveryId: await deliveryIdForIdempotencyKey(idempotencyKey),
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
    // A retried messageId resolves to the session its first attempt created, as eve-channel's
    // operationId does, so a lost response never starts a second context.
    const continuationToken = `a2a:${delivery.idempotencyKey}`;
    const existing = await this.#options.resolveSession(continuationToken);
    if (existing !== undefined) {
      return { deliveryId: delivery.deliveryId, ref: refFor(existing.id, delivery) };
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
    // A context this caller doesn't own is refused, never replaced (spec 3.4.1).
    if (run === undefined || token === undefined) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "Unknown contextId.");
    }
    const sent = { deliveryId: delivery.deliveryId, ref: refFor(contextId, delivery) };
    // A retry of a message that already arrived is that message's task, whatever the context's
    // state now. Otherwise an ended context takes no more tasks.
    if (isEndedRun(run.status)) {
      if (hasDelivery(await readSessionView(contextId), delivery.deliveryId)) return sent;
      throw contextEnded();
    }
    await this.#options.from(token).send(this.#content(message), {
      ...delivery,
      auth: call.auth,
      // A new task waits for the running one instead of steering into it.
      turnPolicy: "queue",
    } as DeliveryOptions);
    return sent;
  }

  async #continueTask(
    message: Message,
    call: A2aCallContext,
    delivery: DeliveryKeys,
  ): Promise<SentDelivery> {
    const { ref, run, token } = await this.#ownedTask(message.taskId!, call.auth);
    if (message.contextId !== undefined && message.contextId !== ref.sessionId) {
      throw new A2aError(A2A_JSON_RPC_ERRORS.invalidParams, "contextId does not match taskId.");
    }
    const sent = { deliveryId: delivery.deliveryId, ref };
    const view = await readSessionView(ref.sessionId);
    if (hasDelivery(view, delivery.deliveryId)) return sent;
    const task = projectTask(view, ref, { historyLength: 0 });
    if (isTerminalState(task.status.state)) {
      throw new A2aError(
        A2A_JSON_RPC_ERRORS.unsupportedOperation,
        "Task is terminal; send a new message in its context instead.",
      );
    }
    if (isEndedRun(run.status)) throw contextEnded();
    const answering = isSettledForBlocking(task.status.state)
      ? { ...sent, answering: statusKey(task) }
      : sent;

    // Working: refine the running turn. Interrupted: eve's typed-answer intake resolves the text
    // against the first open prompt (option id, label, or number), as on any text channel.
    await this.#options.from(token).send(this.#content(message), {
      ...delivery,
      auth: call.auth,
      turnPolicy: "steer",
    } as DeliveryOptions);
    return answering;
  }

  async #ownedTask(taskId: string, auth: SessionAuthContext | null) {
    const ref = decodeTaskId(taskId);
    if (ref === undefined) throw A2aError.taskNotFound();
    const run = await readOwnedInvocationRun(ref.sessionId, auth);
    const token = run === undefined ? undefined : invocationContinuationToken(run);
    if (run === undefined || token === undefined) throw A2aError.taskNotFound();
    return { ref, run, token };
  }

  /** The message as eve content, held to the channel's upload policy. */
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

  /** The task after each change, once the session's stream is caught up, until `signal`. */
  async *#follow(
    sent: SentDelivery,
    options: ProjectTaskOptions,
    signal: AbortSignal,
  ): AsyncGenerator<{ readonly task: Task; readonly read: boolean }, void, undefined> {
    try {
      for await (const view of followSessionView(sent.ref.sessionId, signal)) {
        const task = projectTask(view, sent.ref, options);
        // A message can be consumed a line before the prompt it answers settles: until the
        // status moves past that prompt, the session hasn't acted on the message yet.
        const read =
          hasRead(view, sent.deliveryId) &&
          (sent.answering === undefined || statusKey(task) !== sent.answering);
        yield { read, task };
      }
    } catch (error) {
      // A deadline or a departed client ends the wait; anything else is a real failure.
      if (!signal.aborted) throw error;
    }
  }

  /**
   * The streaming shape of {@link #follow}: the task first, then a status update per change and
   * the reply artifact as the task completes. Ends at a terminal state, at an interrupted state
   * once the session has read the message when `closeOnInterrupt`, or when the client leaves.
   */
  async *#stream(
    sent: SentDelivery,
    options: ProjectTaskOptions,
    signal: AbortSignal,
    mode: { readonly closeOnInterrupt: boolean },
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const contextId = sent.ref.sessionId;
    let last: string | undefined;
    for await (const { read, task } of this.#follow(sent, options, signal)) {
      const key = statusKey(task);
      if (last === undefined) {
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
      if (isTerminalState(state)) return;
      if (mode.closeOnInterrupt && read && isSettledForBlocking(state)) return;
    }
  }
}

interface DeliveryKeys {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
}

/** The task a message reached, and the delivery that carried it. */
interface SentDelivery {
  readonly ref: TaskRef;
  readonly deliveryId: string;
  /** The interrupted status (`statusKey`) the message answers, when it continued one. */
  readonly answering?: string;
}

/** `from().send()` options plus the delivery ID only framework channels pass. */
type DeliveryOptions = Parameters<ReturnType<ChannelFrom>["send"]>[1];

function refFor(sessionId: string, delivery: DeliveryKeys): TaskRef {
  return { deliveryId: delivery.deliveryId, sessionId };
}

/** An eve session whose workflow run finished has ended; its context takes no more messages. */
function isEndedRun(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function contextEnded(): A2aError {
  return new A2aError(
    A2A_JSON_RPC_ERRORS.unsupportedOperation,
    "This context has ended; send the message without a contextId to start a new one.",
  );
}

/** What a stream compares to decide whether the task changed. Timestamps alone don't. */
function statusKey(task: Task): string {
  const { timestamp: _timestamp, ...status } = task.status;
  return JSON.stringify(status);
}

/** A2A parts as eve message content. Data parts become JSON text the model reads. */
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
