import type { ChannelAdapter } from "#channel/adapter.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { createCrossChannelToFn, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import { createSession, type Session } from "#channel/session.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ScheduleIdKey, ScheduleOriginKey } from "#context/keys.js";
import { expectFunction } from "#internal/authored-module.js";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunHandler,
} from "#public/definitions/schedule.js";
import type { ScheduleOccurrence } from "#public/schedules/collection.js";
import {
  parseSchedulePayload,
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
 * session with {@link SCHEDULE_ADAPTER} in task mode and the markdown
 * body as the message.
 *
 * Returns a {@link ScheduleDispatchResult} carrying any sessions the
 * handler started (for telemetry / task-result observability) and the
 * `waitUntil` promises the handler registered.
 */
export interface ScheduleDispatchResult {
  readonly sessions: readonly Session[];
  readonly waitUntilTasks: readonly Promise<unknown>[];
}

export interface ScheduleCollectionDispatchInput {
  readonly collectionId: string;
  readonly payload: ScheduleCollectionPayload;
  readonly occurrence: ScheduleOccurrence;
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
    const scope = new ContextContainer();
    scope.set(ScheduleIdKey, input.collectionId);
    return await contextStorage.run(scope, async () => {
      const payload = parseSchedulePayload(input.payload);
      if (
        payload.binding.collection !== input.collectionId ||
        payload.binding.name !== input.occurrence.name
      ) {
        throw new Error("Schedule payload does not match the occurrence.");
      }
      scope.set(ScheduleOriginKey, payload.origin);
      const auth = payload.runAs === "creator" ? payload.origin.auth.current! : SCHEDULE_APP_AUTH;
      const session = await this.runtime.createSession({
        adapter: SCHEDULE_ADAPTER,
        auth,
        initiatorAuth:
          payload.runAs === "creator" ? (payload.origin.auth.initiator ?? auth) : SCHEDULE_APP_AUTH,
        mode: "task",
        input: {
          message: `This is an occurrence of an existing schedule, not a request to create or change one. Execute the task now using your available tools. Do not create or change another schedule while carrying it out. Your final answer is recorded on this run, not sent to a channel. Only claim a delivery or other side effect after its tool confirms success.\n\nSchedule: ${input.occurrence.name}\nScheduled for: ${input.occurrence.scheduledAt}\n\nRequest:\n${payload.request}`,
        },
      });
      return { sessions: [createSession(session.sessionId, this.runtime)], waitUntilTasks: [] };
    });
  }

  private async triggerInScope(input: ScheduleDispatchInput): Promise<ScheduleDispatchResult> {
    const { args, sessions, waitUntilTasks } = this.createHandlerContext();

    if (input.run) {
      await input.run(args);
    } else if (input.markdown !== undefined) {
      const session = await this.runMarkdown(input.markdown);
      sessions.push(session);
    } else {
      throw new Error(
        `Schedule "${input.scheduleId}" has neither "run" nor "markdown" — at least one must be set.`,
      );
    }

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
      mode: "task",
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
  if (definition === null || typeof definition !== "object") {
    throw new Error(
      `Schedule export "${exportName ?? "default"}" from "${logicalPath}" must be an object.`,
    );
  }
  return expectFunction(
    definition.run,
    `Expected the schedule export "${exportName ?? "default"}" from "${logicalPath}" to export a \`run\` handler function.`,
  ) as ScheduleRunHandler;
}
