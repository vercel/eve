import type { JsonValue } from "#shared/json.js";

/**
 * The language-neutral contract between the `eve__execute` driver and the
 * interpreter that runs a model-written program. A runtime never dispatches a
 * tool itself: every `tools.<name>()` call the program makes parks the program
 * and comes back to the driver as a `ProgramCall`, which the driver resolves
 * through catalog resolution and the normal approval path, records durably,
 * and feeds back on `resume`.
 *
 * Durability is recorded-call replay for every runtime: `state` is whatever
 * the runtime needs to continue (a signed continuation, or nothing when the
 * runtime re-executes the program against the recorded results), and it must
 * be JSON so the driver can carry it across workflow steps.
 */

export type ProgramLanguage = "js" | "py";

/** Hard limits a runtime enforces inside one `start` or `resume`. */
export interface ProgramLimits {
  /** Wall-clock budget for the whole program, across every park and resume. */
  readonly deadlineAt: number;
  /** Calls that may be outstanding (issued, not yet resolved) at once. */
  readonly maxInFlightCalls: number;
  /** Calls the program may issue over its whole run. */
  readonly maxTotalCalls: number;
  /** Interpreter memory ceiling, in bytes. */
  readonly memoryBytes: number;
}

export const DEFAULT_PROGRAM_MAX_IN_FLIGHT_CALLS = 32;
export const DEFAULT_PROGRAM_MAX_TOTAL_CALLS = 256;

/** One `tools.<name>(input)` call the program issued. `index` is its issue order, stable across replays. */
export interface ProgramCall {
  readonly index: number;
  readonly input: JsonValue;
  readonly tool: string;
}

/**
 * How one call ended. `unknown` means the call started but its outcome was
 * never recorded (the run was interrupted mid-call); the program sees it as
 * a thrown error whose message says the side effect may or may not have
 * happened, and the driver never re-runs it.
 */
export type ProgramCallResult =
  | { readonly index: number; readonly output: JsonValue; readonly status: "completed" }
  | { readonly error: string; readonly index: number; readonly status: "failed" }
  | { readonly error: string; readonly index: number; readonly status: "unknown" };

export type ProgramErrorClass =
  | "syntax"
  | "runtime"
  | "deadline"
  | "call-limit"
  | "memory"
  | "unknown-tool";

/**
 * Milliseconds measured by a runtime for this one start/resume call, not the
 * whole program. startupMs is time until the interpreter is ready (zero on a
 * warm/live-cache hit); runMs is the active guest execution slice, excluding
 * time parked between calls waiting for host tools or approval.
 */
export interface ProgramTiming {
  readonly startupMs: number;
  readonly runMs: number;
}

export type ProgramStep =
  | {
      /** Optional runtime measurements for this start/resume call. */
      readonly timing?: ProgramTiming;
      readonly logs: readonly string[];
      readonly output: JsonValue;
      readonly status: "completed";
    }
  | {
      /** Optional runtime measurements for this start/resume call. */
      readonly timing?: ProgramTiming;
      readonly error: string;
      readonly errorClass: ProgramErrorClass;
      readonly logs: readonly string[];
      readonly status: "failed";
    }
  | {
      /** Optional runtime measurements for this start/resume call. */
      readonly timing?: ProgramTiming;
      /** Calls issued since the last step that have no result yet, in index order. */
      readonly calls: readonly ProgramCall[];
      readonly state: JsonValue;
      readonly status: "parked";
    };

export interface ProgramStart {
  readonly limits: ProgramLimits;
  readonly source: string;
  /** Tool names the program may call as `tools.<name>()`; anything else fails as `unknown-tool`. */
  readonly toolNames: readonly string[];
}

export interface ProgramResume extends ProgramStart {
  /** Every result recorded so far, for every call issued so far. */
  readonly results: readonly ProgramCallResult[];
  readonly state: JsonValue;
}

export interface ProgramRuntime {
  readonly language: ProgramLanguage;
  start(input: ProgramStart): Promise<ProgramStep>;
  resume(input: ProgramResume): Promise<ProgramStep>;
}
