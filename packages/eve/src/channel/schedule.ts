import type { ChannelAdapter } from "#channel/adapter.js";
import {
  createCrossChannelReceiveFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import { createSession, type Session } from "#channel/session.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { expectFunction } from "#internal/authored-module.js";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunHandler,
} from "#public/definitions/schedule.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

/**
 * Pre-built application auth context handed to schedules. Schedules
 * run on behalf of the agent itself, not a downstream user.
 */
export const SCHEDULE_APP_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};

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
 * author owns control flow — `args.receive(channel, …)` hands work off
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
    const sessions: Session[] = [];
    const waitUntilTasks: Promise<unknown>[] = [];
    const receive = createCrossChannelReceiveFn(this.runtime, toCrossChannelTargets(this.channels));

    const args: ScheduleHandlerArgs = {
      appAuth: SCHEDULE_APP_AUTH,
      receive: async (channel, options) => {
        const session = await receive(channel, options);
        sessions.push(session);
        return session;
      },
      waitUntil(task) {
        waitUntilTasks.push(task);
      },
    };

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

  private async runMarkdown(markdown: string): Promise<Session> {
    const handle = await this.runtime.run({
      adapter: SCHEDULE_ADAPTER,
      auth: SCHEDULE_APP_AUTH,
      input: { message: markdown },
      mode: "task",
    });
    return createSession(handle.sessionId, handle.continuationToken, this.runtime);
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
