/**
 * Token-usage accumulator for `$eve.*` observability tags and session limits.
 * Lives on `session.state` so the totals survive workflow step boundaries the
 * way the rest of the harness state does.
 *
 * The harness runs each turn as a sequence of `"use step"` invocations
 * (one per tool-loop iteration). Each step knows its own
 * `result.usage`, but the dashboard cares about totals **per turn**.
 * The workflow runtime's attribute store is "last write wins" per key,
 * so the simplest cumulative pattern is: read the previous total from
 * `session.state`, add the new step's usage, write the running total
 * back. The most recent emit then carries the final per-turn total.
 *
 * `turnId` keys the turn totals so a fresh turn starts at zero without relying
 * on a separate "reset" code path. Session totals stay in the same state record
 * and keep accumulating until the durable session ends.
 *
 * `TokenUsageTotals` carries `sawCost` alongside the shared token and token-cost
 * fields so observability can distinguish an unreported cost from a reported
 * zero. {@link toUsage} drops that internal marker when a total crosses into
 * the shared {@link TokenUsage} contract.
 */
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { FIRST_USAGE_WINDOW, type TokenUsage, type UsageByWindow } from "#shared/token-usage.js";

const HARNESS_TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";
const REPORTED_SESSION_USAGE_STATE_KEY = "eve.harness.reportedSessionUsage";
const SESSION_USAGE_WINDOW_START_KEY = "eve.harness.sessionUsageWindowStart";
const SESSION_USAGE_WINDOW_INDEX_KEY = "eve.harness.sessionUsageWindowIndex";
const SESSION_USAGE_RENEWALS_KEY = "eve.harness.sessionUsageRenewals";
/** Usage not yet reported to the caller that was spent outside the current window, by window. */
const UNREPORTED_OFF_WINDOW_KEY = "eve.harness.unreportedUsageOffWindow";
/** Delegated spend in windows of renewals the session hasn't applied yet. */
const WINDOWS_AHEAD_KEY = "eve.harness.usageWindowsAhead";
/** Renewal ids remembered for dedupe; one approval reaches a session by at most a few paths. */
const MAX_REMEMBERED_RENEWALS = 16;

export interface TokenUsageTotals {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly sawCost: boolean;
}

export type TokenUsageDelta = Partial<TokenUsageTotals>;

/**
 * Rolling token usage for the durable session and the in-flight turn.
 *
 * `turnId` is the in-flight turn's stable id; when the harness step
 * runs in a different turn, the flat turn totals reset. The nested
 * `session` totals do not reset.
 */
export interface TurnUsageState extends TokenUsageTotals {
  readonly session: TokenUsageTotals;
  readonly turnId: string;
}

const ZERO_TOKEN_USAGE: TokenUsageTotals = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  sawCost: false,
};

/** Reads the stored per-turn token state, or `undefined` when absent. */
export function getTurnUsageState(state: SessionStateMap | undefined): TurnUsageState | undefined {
  return state?.[HARNESS_TURN_USAGE_STATE_KEY] as TurnUsageState | undefined;
}

export function getSessionTokenUsage(session: Pick<HarnessSession, "state">): TokenUsageTotals {
  return getTurnUsageState(session.state)?.session ?? ZERO_TOKEN_USAGE;
}

/** The session's usage so far, delegated spend included. */
export function getSessionUsage(session: Pick<HarnessSession, "state">): TokenUsage {
  return toUsage(getSessionTokenUsage(session));
}

/** Projects a {@link TokenUsageTotals} down to the cross-cutting {@link TokenUsage} shape. */
export function toUsage(totals: TokenUsageTotals): TokenUsage {
  return {
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsd: totals.sawCost ? totals.costUsd : undefined,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
  };
}

/**
 * What the session spent since the last approved continuation, or since it
 * started. This is the `window` the session usage limit sees.
 */
export function getSessionUsageWindow(session: Pick<HarnessSession, "state">): TokenUsage {
  return toUsage(subtractTokenUsage(getSessionTokenUsage(session), getWindowStart(session)));
}

/**
 * The window the session spends in now: the renewal that started it, or
 * {@link FIRST_USAGE_WINDOW} before any.
 */
export function getSessionUsageWindowId(session: Pick<HarnessSession, "state">): string {
  return latestSessionUsageRenewal(session) ?? FIRST_USAGE_WINDOW;
}

/** How many usage windows the session has started before its current one. */
export function getSessionUsageWindowIndex(session: Pick<HarnessSession, "state">): number {
  return (session.state?.[SESSION_USAGE_WINDOW_INDEX_KEY] as number | undefined) ?? 0;
}

/**
 * Starts a new usage window for an approval the session hasn't applied yet.
 * One approval renews every session in the tree and can reach a session more
 * than once, so the approved request id names the renewal and a repeat is a
 * no-op. `covers` names the session-limit prompts the renewal makes obsolete:
 * they count as applied, so answering one later renews nothing.
 *
 * The window starts at the session's current totals, less what descendants
 * already reported spending in it: they can apply the renewal first.
 */
export function renewSessionUsageWindow<T extends Pick<HarnessSession, "state">>(
  session: T,
  renewalId: string,
  covers: readonly string[] = [],
): { readonly renewed: boolean; readonly session: T } {
  const seen = getSessionUsageRenewals(session);
  if (seen.includes(renewalId)) return { renewed: false, session };
  const totals = getSessionTokenUsage(session);
  const { [renewalId]: early = ZERO_TOKEN_USAGE, ...ahead } = getWindowsAhead(session);
  const { [renewalId]: _now, ...off } = closeCurrentWindow(session);
  const applied = [...seen, ...covers.filter((id) => id !== renewalId), renewalId];
  return {
    renewed: true,
    session: {
      ...session,
      state: {
        ...session.state,
        [SESSION_USAGE_WINDOW_INDEX_KEY]: getSessionUsageWindowIndex(session) + 1,
        [SESSION_USAGE_WINDOW_START_KEY]: subtractTokenUsage(totals, early),
        [SESSION_USAGE_RENEWALS_KEY]: applied.slice(-MAX_REMEMBERED_RENEWALS),
        [UNREPORTED_OFF_WINDOW_KEY]: off,
        [WINDOWS_AHEAD_KEY]: ahead,
      },
    },
  };
}

/** The renewal the session applied last. */
export function latestSessionUsageRenewal(
  session: Pick<HarnessSession, "state">,
): string | undefined {
  return getSessionUsageRenewals(session).at(-1);
}

function getSessionUsageRenewals(session: Pick<HarnessSession, "state">): readonly string[] {
  const stored = session.state?.[SESSION_USAGE_RENEWALS_KEY];
  return Array.isArray(stored) ? (stored as readonly string[]) : [];
}

function getWindowStart(session: Pick<HarnessSession, "state">): TokenUsageTotals {
  return (
    (session.state?.[SESSION_USAGE_WINDOW_START_KEY] as TokenUsageTotals | undefined) ??
    ZERO_TOKEN_USAGE
  );
}

function getReported(session: Pick<HarnessSession, "state">): TokenUsageTotals {
  return (
    (session.state?.[REPORTED_SESSION_USAGE_STATE_KEY] as TokenUsageTotals | undefined) ??
    ZERO_TOKEN_USAGE
  );
}

type TotalsByWindow = Readonly<Record<string, TokenUsageTotals>>;

function getOffWindow(session: Pick<HarnessSession, "state">): TotalsByWindow {
  return (session.state?.[UNREPORTED_OFF_WINDOW_KEY] as TotalsByWindow | undefined) ?? {};
}

function getWindowsAhead(session: Pick<HarnessSession, "state">): TotalsByWindow {
  return (session.state?.[WINDOWS_AHEAD_KEY] as TotalsByWindow | undefined) ?? {};
}

/**
 * The session's unreported spend by window, its current window included:
 * the spend not counted in another window was spent in the current one.
 */
function closeCurrentWindow(session: Pick<HarnessSession, "state">): TotalsByWindow {
  const off = getOffWindow(session);
  const unreported = subtractTokenUsage(getSessionTokenUsage(session), getReported(session));
  const current = Object.values(off).reduce(subtractTokenUsage, unreported);
  return addToWindow(off, getSessionUsageWindowId(session), current);
}

function addToWindow(
  windows: TotalsByWindow,
  windowId: string,
  usage: TokenUsageTotals,
): TotalsByWindow {
  if (isZeroTokenUsage(usage)) return windows;
  return { ...windows, [windowId]: addTokenUsage(windows[windowId] ?? ZERO_TOKEN_USAGE, usage) };
}

/**
 * Counts delegated spend by the window each part was spent in. Spend in
 * another window stays out of this session's: an earlier one ended here, and
 * a later one, from a renewal a descendant applied first, counts once this
 * session applies it too.
 */
export function countUsageByWindow<T extends { readonly state?: SessionStateMap }>(
  session: T,
  windows: UsageByWindow,
): T {
  let next = session;
  for (const [windowId, usage] of Object.entries(windows)) {
    next = countUsageInWindow(next, windowId, usage);
  }
  return next;
}

function countUsageInWindow<T extends { readonly state?: SessionStateMap }>(
  session: T,
  windowId: string,
  spent: TokenUsage,
): T {
  const usage = toTokenUsageDelta(spent);
  if (isZeroTokenUsage(usage)) return session;
  const counted = setTurnUsageState(
    session,
    accumulateSessionUsage({ previous: getTurnUsageState(session.state), usage: spent }),
  );
  if (windowId === getSessionUsageWindowId(session)) return counted;
  const later =
    windowId !== FIRST_USAGE_WINDOW && !getSessionUsageRenewals(session).includes(windowId);
  const ahead = getWindowsAhead(session);
  return {
    ...counted,
    state: {
      ...counted.state,
      [SESSION_USAGE_WINDOW_START_KEY]: addTokenUsage(getWindowStart(session), usage),
      [UNREPORTED_OFF_WINDOW_KEY]: addToWindow(getOffWindow(session), windowId, usage),
      ...(later && {
        [WINDOWS_AHEAD_KEY]: Object.fromEntries(
          Object.entries(addToWindow(ahead, windowId, usage)).slice(-MAX_REMEMBERED_RENEWALS),
        ),
      }),
    },
  };
}

/**
 * Takes the session-usage delta accumulated since the previous take and
 * marks it reported.
 *
 * Persisted on `session.state` (not in step-local memory) so the entry
 * snapshot survives `"use step"` boundaries: the totals at the previous
 * settled turn are the totals at this turn's entry, because a parked child
 * runs no model calls in between. Blocked parks (authorization, queued
 * input) between two settlements never lose usage — the delta always
 * measures everything since the last report, so the deltas of a
 * multi-turn persistent child sum exactly to its session totals.
 *
 * `windows` splits the delta by the usage window it was spent in, so each
 * caller counts it against the same window whenever the report arrives.
 */
export function takeSessionUsageDelta<T extends Pick<HarnessSession, "state">>(
  session: T,
): {
  readonly delta: TokenUsage;
  readonly session: T;
  readonly windows: UsageByWindow;
} {
  const totals = getSessionTokenUsage(session);
  const { [UNREPORTED_OFF_WINDOW_KEY]: _taken, ...state } = session.state ?? {};
  return {
    delta: toUsage(subtractTokenUsage(totals, getReported(session))),
    session: {
      ...session,
      state: { ...state, [REPORTED_SESSION_USAGE_STATE_KEY]: totals },
    },
    windows: Object.fromEntries(
      Object.entries(closeCurrentWindow(session)).map(([id, usage]) => [id, toUsage(usage)]),
    ),
  };
}

function isZeroTokenUsage(usage: TokenUsageTotals): boolean {
  return (
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    usage.costUsd === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0
  );
}

/** Writes per-turn token state onto a new copy of the session. */
export function setTurnUsageState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  next: TurnUsageState,
): T {
  return {
    ...session,
    state: {
      ...session.state,
      [HARNESS_TURN_USAGE_STATE_KEY]: next,
    },
  };
}

/**
 * Folds one step's `usage` into the running per-turn totals. When
 * `turnId` differs from the stored state (e.g. a new turn just
 * started), the previous totals are discarded — fresh turns start at
 * zero without an explicit reset path.
 */
export function accumulateTurnUsage(input: {
  readonly previous: TurnUsageState | undefined;
  readonly turnId: string;
  readonly usage: TokenUsageDelta | undefined;
}): TurnUsageState {
  const delta = toTokenUsageDelta(input.usage);
  const previousSession = input.previous?.session ?? ZERO_TOKEN_USAGE;
  const turnBase =
    input.previous !== undefined && input.previous.turnId === input.turnId
      ? input.previous
      : ZERO_TOKEN_USAGE;

  return {
    ...addTokenUsage(turnBase, delta),
    turnId: input.turnId,
    session: addTokenUsage(previousSession, delta),
  };
}

/** Folds one model call's usage into the session's turn and session totals. */
export function addTurnUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnId: string,
  usage: TokenUsageDelta | undefined,
): T {
  return setTurnUsageState(
    session,
    accumulateTurnUsage({ previous: getTurnUsageState(session.state), turnId, usage }),
  );
}

/**
 * Counts usage that belongs to no turn, such as a manual compaction between turns. It adds to
 * session totals, so session limits see it, and is marked reported so a later turn's usage delta
 * doesn't claim it.
 */
export function addUsageOutsideTurns<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsageDelta | undefined,
): T {
  if (usage === undefined) return session;
  const counted = setTurnUsageState(
    session,
    accumulateSessionUsage({ previous: getTurnUsageState(session.state), usage }),
  );
  const reported =
    (session.state?.[REPORTED_SESSION_USAGE_STATE_KEY] as TokenUsageTotals | undefined) ??
    ZERO_TOKEN_USAGE;
  return {
    ...counted,
    state: {
      ...counted.state,
      [REPORTED_SESSION_USAGE_STATE_KEY]: addTokenUsage(reported, toTokenUsageDelta(usage)),
    },
  };
}

/**
 * Adds usage to session totals without touching the in-flight turn totals:
 * the delegated spend a parent counts, or a run's tally of what its
 * `ctx.agent` sessions spent. Turn tags attribute only the parent's own model
 * calls (child spend is attributed by the caller's durable `execute_tool`
 * span); session totals feed the session token limits and the remaining-quota
 * budget granted to later delegations.
 */
export function accumulateSessionUsage(input: {
  readonly previous: TurnUsageState | undefined;
  readonly usage: TokenUsageDelta;
}): TurnUsageState {
  const delta = toTokenUsageDelta(input.usage);
  const base = input.previous ?? {
    ...ZERO_TOKEN_USAGE,
    session: ZERO_TOKEN_USAGE,
    turnId: "",
  };

  return {
    ...base,
    session: addTokenUsage(base.session, delta),
  };
}

function addTokenUsage(base: TokenUsageTotals, delta: TokenUsageTotals): TokenUsageTotals {
  return {
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    costUsd: base.costUsd + delta.costUsd,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    sawCost: base.sawCost || delta.sawCost,
  };
}

function subtractTokenUsage(total: TokenUsageTotals, base: TokenUsageTotals): TokenUsageTotals {
  return {
    cacheReadTokens: total.cacheReadTokens - base.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - base.cacheWriteTokens,
    costUsd: total.costUsd - base.costUsd,
    inputTokens: total.inputTokens - base.inputTokens,
    outputTokens: total.outputTokens - base.outputTokens,
    sawCost: total.sawCost || base.sawCost,
  };
}

function toTokenUsageDelta(usage: TokenUsageDelta | undefined): TokenUsageTotals {
  if (usage === undefined) {
    return ZERO_TOKEN_USAGE;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    costUsd: usage.costUsd ?? 0,
    inputTokens,
    outputTokens,
    sawCost: usage.costUsd !== undefined,
  };
}
