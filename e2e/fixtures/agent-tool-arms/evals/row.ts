/**
 * The measured row and how it's filled, kept free of eve imports so it can be
 * tested directly (`test/row.test.ts`).
 *
 * A row is filled for every run, including runs whose turn failed, whose
 * `send` threw or timed out, and whose child-session collection failed part
 * way. Whatever events were observed before a failure are still measured, so
 * the efficiency columns average over every attempt.
 *
 * Program fields read `eve__execute` results. A program-capable arm reports
 * interpreter timings by putting `interpreter: { startupMs, runMs }` on the
 * tool's output object, and its failure class as `errorClass` on the output
 * (or `action.result`'s `error.code`). Arms without programs leave them at
 * 0 / null.
 */

/** The program tool; every call to it is one program attempt. */
export const PROGRAM_TOOL = "eve__execute";
/** Catalog tools that find or route to a tool rather than doing the task. */
export const ROUTING_TOOLS = new Set(["eve__search", "eve__tool", "eve__skill"]);

export interface Row {
  id: string;
  arm: string | undefined;
  size: string | undefined;
  model: string | undefined;
  repetition: number;
  success: boolean;
  /** Why the run did not succeed; null when it did. */
  errorClass: string | null;
  harnessError?: string;
  latencyMs: number;
  modelCalls: number;
  missingUsage: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Calls to the task's tools, made by the model directly or from inside a program. */
  actions: number;
  /** `eve__search` / `eve__tool` / `eve__skill` calls. */
  routingCalls: number;
  programAttempts: number;
  programFailures: number;
  /** One class per failed program attempt, in order. */
  programErrorClasses: string[];
  /** Summed over the run's program attempts; null when no attempt reported it. */
  interpreterStartupMs: number | null;
  interpreterRunMs: number | null;
  tools: unknown[];
  message: string | undefined;
}

export type Event = { type: string; data?: any };

export interface TurnLike {
  events: readonly Event[];
  message: string | undefined;
  status: string;
}

/** A turn in progress: `events` fills as the stream arrives, `result()` settles it. */
export interface LiveTurnLike<T extends TurnLike> {
  readonly events: readonly Event[];
  result(): Promise<T>;
}

export function newRow(id: string, env: Record<string, string | undefined>): Row {
  return {
    id,
    arm: env.EVE_ARMS_MODE,
    size: env.EVE_ARMS_SIZE,
    model: env.EVE_E2E_MODEL,
    repetition: Number(env.EVE_ARMS_REPETITION ?? 1),
    success: false,
    errorClass: null,
    latencyMs: 0,
    ...measure([]),
    message: undefined,
  };
}

/**
 * Starts the turn, waits for it, collects child-session events into one list,
 * and fills `row` from whatever was observed. If the turn times out or its
 * stream fails, the events it streamed before that are still measured. Never
 * throws: a failure is returned as `error` after the row is complete, so the
 * caller can write the row first.
 */
export async function measureRun<T extends TurnLike>(input: {
  row: Row;
  expected: string[];
  referenceOf: (name: string) => string;
  start: () => Promise<LiveTurnLike<T>>;
  /** Appends the events of every session the turn opened to `events`. */
  collect: (turn: T, events: Event[]) => Promise<void>;
  now?: () => number;
}): Promise<{ turn?: T; usedExpectedTools: boolean; error?: unknown }> {
  const { row, expected } = input;
  const now = input.now ?? (() => performance.now());
  const events: Event[] = [];
  const start = now();
  let live: LiveTurnLike<T> | undefined;
  let turn: T | undefined;
  let error: unknown;
  try {
    live = await input.start();
    turn = await live.result();
    row.latencyMs = now() - start;
    row.message = turn.message;
    events.push(...turn.events);
    await input.collect(turn, events);
  } catch (caught) {
    error = caught;
    row.latencyMs ||= now() - start;
    if (!turn && live) events.push(...live.events);
  }
  Object.assign(row, measure(events));
  const called = new Set(toolCalls(events).map((a) => a.toolName));
  const usedExpectedTools = expected.every((name) => called.has(name));
  const quoted = expected.every((name) => turn?.message?.includes(input.referenceOf(name)));
  // "waiting" is a turn that ended and left the session open for the next message.
  row.success = !error && turn?.status !== "failed" && usedExpectedTools && quoted;
  row.errorClass = row.success
    ? null
    : error
      ? `harness:${(error as Error)?.name ?? "Error"}`
      : turn?.status === "failed"
        ? `turn-failed:${turnErrorCode(events)}`
        : !usedExpectedTools
          ? "tool-not-called"
          : "reference-missing";
  if (error) row.harnessError = String((error as Error)?.message ?? error).slice(0, 500);
  return { turn, usedExpectedTools, error };
}

/**
 * Every requested call that names a tool, whatever its action kind. A call made
 * from inside a program counts the same as one the model made directly.
 */
export function toolCalls(events: Event[]): { toolName: string }[] {
  return events
    .flatMap((e) => (e.type === "actions.requested" ? e.data.actions : []))
    .filter((a: any) => typeof a?.toolName === "string");
}

export function measure(events: Event[]) {
  const steps = events.filter((e) => e.type === "step.completed");
  const calls = toolCalls(events);
  const programs = events.filter(
    (e) => e.type === "action.result" && e.data.result?.toolName === PROGRAM_TOOL,
  );
  const failed = programs.filter((e) => e.data.status !== "completed" || e.data.result?.isError);
  const timing = (key: "startupMs" | "runMs") => {
    const values = programs
      .map((e) => e.data.result?.output?.interpreter?.[key])
      .filter((v): v is number => typeof v === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const sum = (key: string) => steps.reduce((n, e) => n + (e.data.usage?.[key] ?? 0), 0);
  return {
    modelCalls: steps.length,
    missingUsage: steps.filter((e) => !e.data.usage).length,
    inputTokens: sum("inputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWriteTokens: sum("cacheWriteTokens"),
    actions: calls.filter((a) => a.toolName !== PROGRAM_TOOL && !ROUTING_TOOLS.has(a.toolName))
      .length,
    routingCalls: calls.filter((a) => ROUTING_TOOLS.has(a.toolName)).length,
    programAttempts: calls.filter((a) => a.toolName === PROGRAM_TOOL).length,
    programFailures: failed.length,
    programErrorClasses: failed.map(
      (e) => e.data.result?.output?.errorClass ?? e.data.error?.code ?? e.data.status ?? "unknown",
    ) as string[],
    interpreterStartupMs: timing("startupMs"),
    interpreterRunMs: timing("runMs"),
    tools: calls as unknown[],
  };
}

function turnErrorCode(events: Event[]): string {
  const failure = events.find((e) => e.type === "step.failed" || e.type === "turn.failed");
  return failure?.data?.code ?? "unknown";
}
