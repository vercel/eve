import { scheduleDisplayName } from "#runtime/schedules/record.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import type { Delivery } from "#shared/delivery.js";
import type { MessageContent } from "#shared/message-content.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { commandDelivery } from "#channel/delivery.js";
import type {
  DispatchContinuationInput,
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, OccurrenceIdKey, ScheduleIdKey, ScheduleInstanceKey } from "#context/keys.js";
import { expectFunction } from "#internal/authored-module.js";
import { PermanentScheduleMessageError } from "#internal/schedules/permanent-error.js";
import { platformContext } from "#platform/context.js";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunHandler,
} from "#public/definitions/schedule.js";
import type {
  DynamicSchedulesDefinition,
  DynamicSchedulesRunArgs,
  ScheduleOccurrenceIdentity,
  SchedulePrincipalReference,
} from "#public/schedules/subscription.js";
import {
  parseSchedulePayload,
  validateSchedulePayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { randomUUID } from "#runtime-env/uuid.js";
import { concatBytes, utf8Bytes } from "#shared/bytes.js";
import { sha256Hex } from "#shared/digest.js";

export { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";

export const SCHEDULE_ADAPTER_KIND = "schedule";

export const SCHEDULE_ADAPTER: ChannelAdapter = {
  kind: SCHEDULE_ADAPTER_KIND,
};
export interface ScheduleDispatchInput {
  readonly scheduleId: string;
  readonly run?: ScheduleRunHandler;
  readonly markdown?: string;
}
export interface ScheduleDispatchResult {
  readonly sessions: readonly Delivery[];
  readonly waitUntilTasks: readonly Promise<unknown>[];
}
export interface ScheduleCollectionDispatchInput {
  readonly collectionId: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly payload: ScheduleCollectionPayload<unknown>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly schedule: DynamicSchedulesRunArgs<unknown>["schedule"];
  readonly verifyDelivery?: () => Promise<void>;
}

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
    const auth = resolveCreatorAuth(
      await definition.auth({
        principal: envelope.principal,
        payload,
        occurrence,
        schedule: input.schedule,
      }),
      envelope.principal,
    );
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.collectionId);
    scope.set(AuthKey, auth);
    scope.set(OccurrenceIdKey, occurrence.executionId);
    scope.set(ScheduleInstanceKey, occurrence.name);
    const scheduledToken = (channelToken: string | undefined, key: string | undefined) =>
      key === undefined
        ? `eve-scheduled-send:${randomUUID()}`
        : `eve-scheduled-send:${sha256Hex(JSON.stringify([occurrence.scheduleId, channelToken, key]))}`;
    const repeats = new Map<unknown, Map<string, number>>();
    const occurrenceKey = (channel: unknown, target: unknown, message: MessageContent): string => {
      const digest = messageDigest(message);
      const sent = repeats.get(channel) ?? new Map<string, number>();
      repeats.set(channel, sent);
      const slot = JSON.stringify([target, digest]);
      const repeat = sent.get(slot) ?? 0;
      sent.set(slot, repeat + 1);
      return `eve-occurrence:${sha256Hex(JSON.stringify([occurrence.executionId, digest, repeat]))}`;
    };
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
          if (delivery.command.kind !== "send")
            throw new Error("Scheduled channel receive can only start a fresh session.");
          return { status: "session_not_active" } as SessionCommandResult<TCommand>;
        },
        createSession: async (run) => await this.runtime.createSession(freshRun(run)),
      };
      const { args, sessions, waitUntilTasks } = this.createHandlerContext(runtime);
      await definition.run({
        payload,
        occurrence,
        auth,
        schedule: input.schedule,
        to: (channel, target) => ({
          send: (message, options) =>
            args.to(channel, target).send(message, {
              ...options,
              idempotencyKey: options?.idempotencyKey ?? occurrenceKey(channel, target, message),
              auth,
            }),
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
    const toChannel = createCrossChannelToFn(runtime, toCrossChannelTargets(this.channels), {
      acceptedDeploymentId: platformContext().deployment.deploymentId(),
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

function messageDigest(message: MessageContent): string {
  const chunks: Uint8Array[] = [];
  const field = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? utf8Bytes(value) : value;
    chunks.push(utf8Bytes(`${bytes.byteLength}:`), bytes);
  };
  for (const part of typeof message === "string"
    ? [{ type: "text", text: message } as const]
    : message) {
    field(part.type);
    if (part.type === "text") {
      field(part.text);
      continue;
    }
    field(part.mediaType);
    field(part.filename ?? "");
    const { data } = part;
    if (typeof data === "string") {
      field("encoded");
      field(data);
    } else if (data instanceof URL) {
      field("url");
      field(data.href);
    } else {
      field("bytes");
      field(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    }
  }
  return sha256Hex(concatBytes(chunks));
}

function resolveCreatorAuth(
  resolved: Awaited<ReturnType<DynamicSchedulesDefinition["auth"]>>,
  principal: SchedulePrincipalReference,
): SessionAuthContext {
  if (resolved === null)
    throw new PermanentScheduleMessageError(
      'Scheduled execution is no longer authorized: "auth" returned null for the schedule creator.',
    );
  if (typeof resolved === "object" && "principalId" in resolved) {
    if (
      resolved.principalId !== principal.principalId ||
      resolved.principalType !== principal.type ||
      resolved.authenticator !== principal.authenticator ||
      resolved.issuer !== principal.issuer ||
      resolved.subject !== principal.subject
    )
      throw new PermanentScheduleMessageError(
        "Scheduled execution auth must resolve the schedule creator.",
      );
    return resolved;
  }
  const attributes = (resolved as { readonly attributes?: unknown } | undefined)?.attributes;
  if (typeof attributes !== "object" || attributes === null)
    throw new PermanentScheduleMessageError(
      'Scheduled execution "auth" must return { attributes }, a SessionAuthContext for the schedule creator, or null.',
    );
  const auth: { -readonly [K in keyof SessionAuthContext]: SessionAuthContext[K] } = {
    attributes: attributes as SessionAuthContext["attributes"],
    authenticator: principal.authenticator,
    principalId: principal.principalId,
    principalType: principal.type,
  };
  if (principal.issuer !== undefined) auth.issuer = principal.issuer;
  if (principal.subject !== undefined) auth.subject = principal.subject;
  return auth;
}

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
