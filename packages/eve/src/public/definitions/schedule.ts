import type { CrossChannelReceiveFn } from "#channel/cross-channel-receive.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

export type { InferReceiveTarget, TypedReceiveTarget } from "#channel/receive-target.js";

/**
 * Arguments passed to a schedule's `run` handler. A tight subset of a route
 * handler's args: `receive` starts a session on another channel and `waitUntil`
 * extends the task lifetime. There is no `send` because a schedule has no
 * current channel.
 */
export interface ScheduleHandlerArgs {
  /**
   * Starts a session on another channel, using the same contract as a route
   * handler's `args.receive(channel, ...)`.
   */
  readonly receive: CrossChannelReceiveFn;
  /**
   * Extends the cron task's lifetime past handler return so the runtime awaits
   * background work (the parked workflow session, in-flight fetches, etc.)
   * before the Nitro task ends.
   */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /**
   * Pre-built APP auth context. Pass this to `receive(channel, { auth })`
   * for schedules that run on behalf of the agent itself.
   */
  readonly appAuth: SessionAuthContext;
}

/**
 * The `run` form of {@link ScheduleDefinition} invokes this handler when a
 * schedule's cron fires. It receives {@link ScheduleHandlerArgs} (`receive`,
 * `waitUntil`, `appAuth`) and may return synchronously or as a promise.
 */
export type ScheduleRunHandler = (args: ScheduleHandlerArgs) => Promise<void> | void;

/** Constraint shape that bounds the authored keys accepted by {@link defineSchedule}. */
interface ScheduleDefinitionFields {
  readonly cron: string;
  readonly markdown?: string;
  readonly run?: ScheduleRunHandler;
}

/**
 * Public definition for a schedule authored in TypeScript. Provide a required
 * `cron` expression plus exactly one of `markdown` or `run`:
 *
 * - `markdown`: fire-and-forget agent invocation. The framework runs the agent
 *   on the prompt and discards the output (equivalent to the `<name>.md`
 *   markdown form).
 * - `run`: full handler ({@link ScheduleRunHandler}). Receives
 *   `{ receive, waitUntil, appAuth }` and decides what to do.
 *
 * Identity is derived from the file path under `agent/schedules/`; authored
 * definitions do not carry a `name` field.
 */
export type ScheduleDefinition =
  | {
      readonly cron: string;
      readonly markdown: string;
      readonly run?: never;
    }
  | {
      readonly cron: string;
      readonly markdown?: never;
      readonly run: ScheduleRunHandler;
    };

/**
 * Defines a schedule in TypeScript. Export as the default from
 * `agent/schedules/<name>.ts`. Pass a `cron` expression plus exactly one of
 * `markdown` (fire-and-forget prompt) or `run` (handler); the schedule name
 * comes from the file path under `agent/schedules/`.
 *
 * @example Start a session on Slack:
 * ```ts
 * import { defineSchedule } from "eve/schedules";
 * import slack from "../channels/slack.js";
 *
 * export default defineSchedule({
 *   cron: "0 9 * * 1-5",
 *   async run({ receive, waitUntil, appAuth }) {
 *     waitUntil(receive(slack, {
 *       message: "Post the daily standup summary.",
 *       target: { channelId: "C0123ABC" },
 *       auth: appAuth,
 *     }));
 *   },
 * });
 * ```
 *
 * @example Fire-and-forget:
 * ```ts
 * export default defineSchedule({
 *   // The real value is "asterisk-slash-5 * * * *" (every 5 minutes). The
 *   // space below is only here so the literal stays inside this block comment.
 *   cron: "* / 5 * * * *",
 *   markdown: "Sync open Linear issues to the metrics dashboard.",
 * });
 * ```
 */
export function defineSchedule<TSchedule extends ScheduleDefinition>(
  definition: ExactDefinition<TSchedule, ScheduleDefinitionFields>,
): TSchedule {
  return definition;
}
