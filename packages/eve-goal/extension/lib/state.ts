import { defineState } from "eve/context";

export type GoalStatus = "active" | "paused" | "met" | "impossible";

/** The session's goal. One per session; setting a new one replaces it. */
export interface Goal {
  readonly objective: string;
  readonly status: GoalStatus;
  /** Follow-ups the goal has queued. */
  readonly runs: number;
  readonly maxRuns: number;
  /** Follow-up turns in a row that made no tool calls. */
  readonly idleRuns: number;
  /** The goal queued the follow-up the next turn runs on. */
  readonly followedUp?: boolean;
  /** Session spend when the goal was set, once a call settles after it. */
  readonly costAtStart?: number;
  /** Why the goal last continued, paused, or settled. */
  readonly lastReason?: string;
}

export const goal = defineState<Goal | null>("goal", () => null);

export const MAX_OBJECTIVE_LENGTH = 4_000;
