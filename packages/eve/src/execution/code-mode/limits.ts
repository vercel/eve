// The fixed limits of an `eve__execute` program. None is a setting.

/** Tool calls and searches one program may make. */
export const PROGRAM_MAX_CALLS = 1024;
/** Calls to agents one program may make: each is a child session. */
export const PROGRAM_MAX_AGENT_CALLS = 128;
/** Calls a program step runs at once; it queues the rest. Parked calls don't count. */
export const PROGRAM_MAX_INLINE_CALLS = 32;
/** Guest JavaScript time per program step. Time spent waiting on calls doesn't count. */
export const PROGRAM_CPU_TIMEOUT_MS = 30_000;
/** Wall-clock time per program step, calls it runs included. Parked calls don't count. */
export const PROGRAM_TIMEOUT_MS = 300_000;
export const PROGRAM_MEMORY_BYTES = 64 * 1024 * 1024;
export const PROGRAM_STACK_BYTES = 2 * 1024 * 1024;
export const PROGRAM_MAX_SOURCE_BYTES = 256 * 1024;
export const PROGRAM_MAX_CONSOLE_BYTES = 64 * 1024;
/** Size limit for the JSON text of one call's input, and of the program's return value. */
export const PROGRAM_MAX_INPUT_BYTES = 1024 * 1024;
/** Size limit for the JSON text of one call's output. */
export const PROGRAM_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Size limit for a parked program's continuation, which holds every recorded result. */
export const PROGRAM_MAX_CONTINUATION_BYTES = 8 * 1024 * 1024;
/** What reaches the model of a program's result, in estimated tokens. */
export const PROGRAM_MAX_RESULT_TOKENS = 10_000;
