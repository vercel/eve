/**
 * The `run` form of {@link ScheduleDefinition} invokes this handler when a
 * schedule's cron fires. It receives {@link ScheduleHandlerArgs} (`receive`,
 * `waitUntil`, `appAuth`) and may return synchronously or as a promise.
 */
export type GenericScheduleRunHandler<TArgs> = (args: TArgs) => Promise<void> | void;

/** Constraint shape that bounds the authored keys accepted by {@link defineSchedule}. */
export interface GenericScheduleDefinitionFields<TArgs> {
  readonly cron: string;
  readonly markdown?: string;
  readonly run?: GenericScheduleRunHandler<TArgs>;
}

/**
 * Public definition for a schedule authored in TypeScript. Provide a required
 * `cron` expression plus exactly one of `markdown` or `run`:
 *
 * - `markdown`: fire-and-forget agent invocation. The framework runs the agent
 *   on the prompt and discards the output (equivalent to the `<name>.md`
 *   markdown form).
 * - `run`: full handler ({@link GenericScheduleRunHandler}). Receives
 *   `{ receive, waitUntil, appAuth }` and decides what to do.
 *
 * Identity is derived from the file path under `agent/schedules/`; authored
 * definitions do not carry a `name` field.
 */
export type GenericScheduleDefinition<TArgs> =
  | {
      readonly cron: string;
      readonly markdown: string;
      readonly run?: never;
    }
  | {
      readonly cron: string;
      readonly markdown?: never;
      readonly run: GenericScheduleRunHandler<TArgs>;
    };
