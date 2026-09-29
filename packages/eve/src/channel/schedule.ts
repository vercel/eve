import { randomUUID } from "node:crypto";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import { createSession, type Session } from "#channel/session.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ExtensionConfigsKey,
  OccurrenceIdKey,
  ScheduleIdKey,
  ScheduleInstanceKey,
} from "#context/keys.js";
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
  readonly sessions: readonly Session[];
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
  private readonly extensionConfigs: ReadonlyMap<string, Record<string, unknown>>;
  constructor(config: {
    readonly runtime: Runtime;
    readonly channels: readonly ResolvedChannelDefinition[];
    /** Root extension configs the schedule's `run` reads through `extension.config`. */
    readonly extensionConfigs: ReadonlyMap<string, Record<string, unknown>>;
  }) {
    this.runtime = config.runtime;
    this.channels = config.channels;
    this.extensionConfigs = config.extensionConfigs;
  }

  async trigger(input: ScheduleDispatchInput): Promise<ScheduleDispatchResult> {
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.scheduleId);
    scope.setVirtualContext(ExtensionConfigsKey, this.extensionConfigs);
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
    return await contextStorage.run(scope, async () => {
      const runtime: Runtime = {
        ...this.runtime,
        // A scheduled send must not steer an existing conversation or inherit interactive input.
        resolveContinuation: async () => undefined,
        dispatchContinuation: async <TCommand extends import("#channel/types.js").SessionCommand>(
          delivery: import("#channel/types.js").DispatchContinuationInput<TCommand>,
        ) => {
          if (delivery.command.kind !== "send")
            throw new Error("Scheduled channel receive can only start a fresh session.");
          return {
            status: "session_not_active",
          } as import("#channel/types.js").SessionCommandResult<TCommand>;
        },
        createSession: async (run) =>
          await this.runtime.createSession({
            ...run,
            auth,
            initiatorAuth: auth,
            capabilities: { requestInput: false },
            continuationToken: `eve-scheduled-send:${randomUUID()}`,
            continuationConflictCommand: undefined,
          }),
      };
      const { args, sessions, waitUntilTasks } = this.createHandlerContext(runtime);
      await definition.run({
        payload,
        occurrence,
        auth,
        to: (channel, target) => ({
          send: (message) => args.to(channel, target).send(message, { auth }),
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
    sessions: Session[];
    waitUntilTasks: Promise<unknown>[];
  } {
    const sessions: Session[] = [];
    const waitUntilTasks: Promise<unknown>[] = [];
    const toChannel = createCrossChannelToFn(runtime, toCrossChannelTargets(this.channels));
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

  private async runMarkdown(markdown: string): Promise<Session> {
    const handle = await this.runtime.createSession({
      adapter: SCHEDULE_ADAPTER,
      auth: SCHEDULE_APP_AUTH,
      input: { message: markdown },
    });
    return createSession(handle.sessionId, this.runtime);
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
