import { createHash } from "node:crypto";
import type { ChannelAdapter } from "#channel/adapter.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import {
  createScheduleCollectionAdapterState,
  markScheduledRunAuth,
  scheduleCollectionEventHandlers,
  scheduleDeliveryOutputSchema,
} from "#channel/schedule-collection-adapter.js";
import { createSession, type Session } from "#channel/session.js";
import { resolveCreateOnceOwner } from "#runtime/schedules/resolve-occurrence-owner.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, ScheduleIdKey } from "#context/keys.js";
import { expectFunction } from "#internal/authored-module.js";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunHandler,
} from "#public/definitions/schedule.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleOccurrenceIdentity,
} from "#public/schedules/collection.js";
import {
  parseSchedulePayload,
  type ScheduleCollectionPayload,
} from "#runtime/schedules/payload.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

export { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
export const SCHEDULE_ADAPTER_KIND = "schedule";
export const SCHEDULE_ADAPTER: ChannelAdapter = {
  kind: SCHEDULE_ADAPTER_KIND,
  ...scheduleCollectionEventHandlers,
};
export interface ScheduleDispatchInput {
  readonly scheduleId: string;
  readonly run?: ScheduleRunHandler;
  readonly markdown?: string;
}
export interface ScheduleDispatchResult {
  readonly sessions: readonly Session[];
  readonly waitUntilTasks: readonly Promise<unknown>[];
}
export interface ScheduleCollectionDispatchInput {
  readonly collectionId: string;
  readonly definition: ScheduleCollectionDefinition<any, any>;
  readonly payload: ScheduleCollectionPayload<unknown, unknown>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly scheduleName: string;
  readonly namespace: string;
  readonly verifyNewAdmission?: () => Promise<void>;
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
    const parsed = parseSchedulePayload<unknown, unknown>(input.payload, {
      application: input.payload.eve.application,
      collection: input.collectionId,
    });
    const { envelope } = parsed;
    const { occurrence, definition } = input;
    if (typeof envelope.request !== "string" || envelope.request.trim().length === 0) {
      throw new Error("Scheduled request must be a non-empty string.");
    }
    const names = Object.keys(envelope.deliveries);
    // One delivery takes the plain final reply; structured output is only needed to split content
    // across several, and models often answer a schema with JSON typed as prose.
    const deliveryGuidance =
      names.length === 1
        ? `You need no tool to deliver the result and must not say you cannot post: your final reply is delivered for you. Make your final reply the content itself, exactly as it should appear, with no remarks about scheduling or delivery. Where it will appear: ${definition.deliveries[names[0]!]?.description ?? names[0]}`
        : `You need no tool to deliver the results and must not say you cannot post: they are delivered for you. When you finish, call final_output with one entry for each delivery below, each written exactly as it should appear.\n${names
            .map((name) => `- ${name}: ${definition.deliveries[name]?.description ?? name}`)
            .join("\n")}`;
    const request = `This scheduled occurrence is firing now. Perform the request below now, not at a later time. Do not create or change schedules, or merely promise to do the work. ${deliveryGuidance}\n\nSchedule: ${occurrence.name}\nScheduled for: ${occurrence.scheduledAt}\n\nRequest:\n${envelope.request}`;
    const occurrenceToken = occurrenceContinuationToken(input, occurrence);
    const existing = await this.runtime.resolveContinuation(occurrenceToken);
    if (existing !== undefined) {
      return { sessions: [createSession(existing.sessionId, this.runtime)], waitUntilTasks: [] };
    }
    for (const name of names) {
      if (!Object.hasOwn(definition.deliveries, name))
        throw new Error(`Scheduled delivery "${name}" is no longer configured.`);
    }
    await input.verifyNewAdmission?.();
    const resolvedAuth = await definition.auth({
      principal: envelope.principal,
      metadata: envelope.metadata,
      occurrence,
    });
    if (resolvedAuth === null) throw new Error("Scheduled execution is no longer authorized.");
    const auth = markScheduledRunAuth(resolvedAuth);
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.collectionId);
    scope.set(AuthKey, auth as never);
    return await contextStorage.run(scope, async () => {
      await this.runtime.createSession({
        adapter: {
          ...SCHEDULE_ADAPTER,
          state: createScheduleCollectionAdapterState({
            collection: input.collectionId,
            deliveries: envelope.deliveries,
            metadata: envelope.metadata,
            occurrence,
            principal: envelope.principal,
          }),
        },
        auth,
        continuationToken: occurrenceToken,
        occurrenceToken,
        capabilities: { requestInput: false },
        input:
          names.length === 1
            ? { message: request }
            : { message: request, outputSchema: scheduleDeliveryOutputSchema(definition, names) },
      });
      const session = createSession(
        await resolveCreateOnceOwner(this.runtime, occurrenceToken),
        this.runtime,
      );
      return { sessions: [session], waitUntilTasks: [] };
    });
  }

  private async triggerInScope(input: ScheduleDispatchInput): Promise<ScheduleDispatchResult> {
    const { args, sessions, waitUntilTasks } = this.createHandlerContext();
    if (input.run) await input.run(args);
    else if (input.markdown !== undefined) sessions.push(await this.runMarkdown(input.markdown));
    else throw new Error(`Schedule "${input.scheduleId}" has neither "run" nor "markdown".`);
    return { sessions, waitUntilTasks };
  }

  private createHandlerContext(): {
    args: ScheduleHandlerArgs;
    sessions: Session[];
    waitUntilTasks: Promise<unknown>[];
  } {
    const sessions: Session[] = [];
    const waitUntilTasks: Promise<unknown>[] = [];
    const toChannel = createCrossChannelToFn(this.runtime, toCrossChannelTargets(this.channels));
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

function occurrenceContinuationToken(
  input: ScheduleCollectionDispatchInput,
  occurrence: ScheduleOccurrenceIdentity,
): string {
  const binding = createHash("sha256")
    .update(
      JSON.stringify([input.namespace, input.scheduleName, occurrence.scheduledAt, input.payload]),
    )
    .digest("base64url");
  return `eve-scheduled:${deriveEveScheduleQueueTopic(input.payload.eve.application)}:${input.collectionId}:${occurrence.scheduleId}:${occurrence.executionId}:${binding}`;
}

export function expectScheduleRun(
  value: unknown,
  logicalPath: string,
  _exportName: string | undefined,
): ScheduleRunHandler {
  const definition = value as ScheduleDefinition;
  if (definition === null || typeof definition !== "object")
    throw new Error(`Schedule export from "${logicalPath}" must be an object.`);
  return expectFunction(
    definition.run,
    `Expected schedule export from "${logicalPath}" to export a run handler.`,
  ) as ScheduleRunHandler;
}
