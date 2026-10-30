import { createHash, randomUUID } from "node:crypto";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import type { Delivery } from "#shared/delivery.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { commandDelivery } from "#channel/delivery.js";
import type {
  DispatchContinuationInput,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, OccurrenceIdKey, ScheduleIdKey, ScheduleInstanceKey } from "#context/keys.js";
import { expectFunction } from "#internal/authored-module.js";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunHandler,
} from "#public/definitions/schedule.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleOccurrenceIdentity,
} from "#public/schedules/subscription.js";
import {
  parseSchedulePayload,
  validateSchedulePayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

export { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";

/**
 * Durable adapter kind used when a schedule fires without targeting a
 * channel — the markdown form, and the synthesized run the dispatcher
 * builds for it.
 *
 * Framework-owned — authored code never constructs a schedule adapter
 * directly. Registered in `FRAMEWORK_ADAPTERS`.
 */
export const SCHEDULE_ADAPTER_KIND = "schedule";

export const SCHEDULE_ADAPTER: ChannelAdapter = {
  kind: SCHEDULE_ADAPTER_KIND,
};
/**
 * Loaded shape of one schedule for the dispatcher. Either `run` is
 * defined (authored handler) or `markdown` is defined (fire-and-forget).
 */
export interface ScheduleDispatchInput {
  readonly scheduleId: string;
  readonly run?: ScheduleRunHandler;
  readonly markdown?: string;
}
/** Sessions started by dispatch and background work registered by the handler. */
export interface ScheduleDispatchResult {
  readonly sessions: readonly Delivery[];
  readonly waitUntilTasks: readonly Promise<unknown>[];
}
export interface ScheduleCollectionDispatchInput {
  readonly collectionId: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly payload: ScheduleCollectionPayload<unknown>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly verifyDelivery?: () => Promise<void>;
}

/**
 * Dispatches scheduled task execution.
 *
 * For handler schedules: builds {@link ScheduleHandlerArgs} against the
 * request-scoped channel bundle and invokes the author's `run`. The
 * author owns control flow — `args.to(channel, target).send(…)` hands work off
 * to a channel; `args.waitUntil(promise)` extends the task lifetime
 * so the dispatcher awaits in-flight work before settling.
 *
 * For markdown schedules: synthesizes a channel-less run that starts a
 * session with {@link SCHEDULE_ADAPTER} and the markdown body as the
 * message.
 *
 * Returns a {@link ScheduleDispatchResult} carrying any sessions the
 * handler started (for telemetry / task-result observability) and the
 * `waitUntil` promises the handler registered. Subscription callbacks resolve
 * creator auth and await their registered work before returning; their channel
 * sends start fresh, unattended sessions rather than resume a conversation.
 */
export class ScheduleDispatcher {
  private readonly runtime: Runtime;
  private readonly channels: readonly ResolvedChannelDefinition[];
  constructor(config: {
    readonly runtime: Runtime;
    readonly channels: readonly ResolvedChannelDefinition[];
  }) {
    this.runtime = config.runtime;
    this.channels = config.channels;
  }

  async trigger(input: ScheduleDispatchInput): Promise<ScheduleDispatchResult> {
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.scheduleId);
    return await contextStorage.run(scope, () => this.triggerInScope(input));
  }

  async triggerCollection(input: ScheduleCollectionDispatchInput): Promise<ScheduleDispatchResult> {
    const parsed = parseSchedulePayload<unknown>(input.payload, {
      application: input.payload.eve.application,
      collection: input.collectionId,
    });
    const { envelope } = parsed;
    const { definition } = input;
    const occurrence = {
      ...input.occurrence,
      displayName: scheduleDisplayName(input.occurrence.name),
    };
    const payload =
      definition.preparePayload === undefined
        ? await validateSchedulePayload(definition.inputSchema, envelope.payload)
        : envelope.payload;
    await input.verifyDelivery?.();
    const resolvedAuth = await definition.auth({
      principal: envelope.principal,
      payload,
      occurrence,
    });
    if (resolvedAuth === null) throw new Error("Scheduled execution is no longer authorized.");
    if (
      resolvedAuth.principalId !== envelope.principal.principalId ||
      resolvedAuth.principalType !== envelope.principal.type ||
      resolvedAuth.authenticator !== envelope.principal.authenticator ||
      resolvedAuth.issuer !== envelope.principal.issuer ||
      resolvedAuth.subject !== envelope.principal.subject
    )
      throw new Error("Scheduled execution auth must resolve the schedule creator.");
    const auth = resolvedAuth;
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.collectionId);
    scope.set(AuthKey, auth);
    scope.set(OccurrenceIdKey, occurrence.executionId);
    scope.set(ScheduleInstanceKey, occurrence.name);
    // A scheduled send must not steer a conversation it didn't start, so it never reaches the
    // channel's address. A keyed send gets an address of its own, scoped to this schedule, so a
    // retried callback reaches the session its first attempt started.
    const scheduledToken = (channelToken: string | undefined, key: string | undefined) =>
      key === undefined
        ? `eve-scheduled-send:${randomUUID()}`
        : `eve-scheduled-send:${createHash("sha256")
            .update(JSON.stringify([occurrence.scheduleId, channelToken, key]))
            .digest("hex")}`;
    const freshRun = (run: RunInput): RunInput => ({
      ...run,
      auth,
      initiatorAuth: auth,
      capabilities: { requestInput: false },
      continuationToken: scheduledToken(run.continuationToken, run.idempotencyKey),
      continuationConflictCommand:
        run.idempotencyKey === undefined ? undefined : run.continuationConflictCommand,
    });
    return await contextStorage.run(scope, async () => {
      const runtime: Runtime = {
        ...this.runtime,
        resolveContinuation: async () => undefined,
        dispatchContinuation: async <TCommand extends SessionCommand>(
          delivery: DispatchContinuationInput<TCommand>,
        ) => {
          const { command } = delivery;
          if (command.kind !== "send")
            throw new Error("Scheduled channel receive can only start a fresh session.");
          if (command.idempotencyKey === undefined)
            return { status: "session_not_active" } as SessionCommandResult<TCommand>;
          return await this.runtime.dispatchContinuation({
            command,
            continuationToken: scheduledToken(delivery.continuationToken, command.idempotencyKey),
            successor: delivery.successor && freshRun(delivery.successor),
          });
        },
        createSession: async (run) => await this.runtime.createSession(freshRun(run)),
      };
      const { args, sessions, waitUntilTasks } = this.createHandlerContext(runtime);
      await definition.run({
        payload,
        occurrence,
        auth,
        to: (channel, target) => ({
          send: (message, options) => args.to(channel, target).send(message, { ...options, auth }),
        }),
        waitUntil: args.waitUntil,
      });
      await Promise.all(waitUntilTasks);
      return { sessions, waitUntilTasks };
    });
  }

  private async triggerInScope(input: ScheduleDispatchInput): Promise<ScheduleDispatchResult> {
    const { args, sessions, waitUntilTasks } = this.createHandlerContext();
    if (input.run) await input.run(args);
    else if (input.markdown !== undefined) sessions.push(await this.runMarkdown(input.markdown));
    else
      throw new Error(
        `Schedule "${input.scheduleId}" has neither "run" nor "markdown" — at least one must be set.`,
      );
    return { sessions, waitUntilTasks };
  }

  private createHandlerContext(runtime = this.runtime): {
    args: ScheduleHandlerArgs;
    sessions: Delivery[];
    waitUntilTasks: Promise<unknown>[];
  } {
    const sessions: Delivery[] = [];
    const waitUntilTasks: Promise<unknown>[] = [];
    // On Vercel, the deployment serving the schedule accepts its sends, so a
    // session they continue hands off to it like one a route reaches.
    const toChannel = createCrossChannelToFn(runtime, toCrossChannelTargets(this.channels), {
      acceptedDeploymentId: process.env.VERCEL_DEPLOYMENT_ID?.trim() || undefined,
    });
    return {
      args: {
        appAuth: SCHEDULE_APP_AUTH,
        to(channel, target) {
          const destination = toChannel(channel, target);
          return {
            async send(message, options) {
              const session = await destination.send(message, options);
              sessions.push(session);
              return session;
            },
          };
        },
        waitUntil(task) {
          waitUntilTasks.push(task);
        },
      },
      sessions,
      waitUntilTasks,
    };
  }

  private async runMarkdown(markdown: string): Promise<Delivery> {
    const delivery = createChannelDeliveryMetadata({
      channelKind: "schedule",
      channelName: "schedule",
    });
    const handle = await this.runtime.createSession({
      delivery,
      adapter: SCHEDULE_ADAPTER,
      auth: SCHEDULE_APP_AUTH,
      input: { message: markdown },
    });
    return commandDelivery(
      this.runtime,
      { status: "accepted", sessionId: handle.sessionId },
      delivery.deliveryId,
    );
  }
}

/**
 * Convenience: extract a `run` function from one loaded schedule module
 * value, or throw with the file path so misconfigured modules fail
 * obviously instead of crashing deep inside the dispatcher.
 */
export function expectScheduleRun(
  value: unknown,
  logicalPath: string,
  exportName: string | undefined,
): ScheduleRunHandler {
  const definition = value as ScheduleDefinition;
  if (definition === null || typeof definition !== "object")
    throw new Error(
      `Schedule export "${exportName ?? "default"}" from "${logicalPath}" must be an object.`,
    );
  return expectFunction(
    definition.run,
    `Expected the schedule export "${exportName ?? "default"}" from "${logicalPath}" to export a \`run\` handler function.`,
  ) as ScheduleRunHandler;
}
