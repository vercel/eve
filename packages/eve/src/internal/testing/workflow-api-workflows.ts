import { createHook, FatalError, RetryableError } from "#compiled/@workflow/core/index.js";

export async function hookRegistrationWorkflow(token: string, hold = false) {
  "use workflow";

  using hook = createHook<string>({ token });
  const conflict = await hook.getConflict();
  if (conflict !== null) {
    const repeated = await hook.getConflict();
    try {
      await hook;
    } catch (error) {
      return {
        owner: conflict.runId,
        repeatedOwner: repeated?.runId,
        payloadError:
          typeof error === "object" && error !== null && "name" in error ? error.name : undefined,
      };
    }
  }
  return { owner: null, payload: hold ? await hook : undefined };
}

async function failStep(kind: "fatal" | "retryable") {
  "use step";

  if (kind === "fatal") throw new FatalError("Cannot continue");
  throw new RetryableError("Try again later", { retryAfter: new Date("2026-01-01T00:00:00Z") });
}
failStep.maxRetries = 0;

export async function catchWorkflowError(kind: "fatal" | "retryable") {
  "use workflow";

  try {
    await failStep(kind);
  } catch (error) {
    // The SDK wraps an exhausted retry in FatalError, preserving its cause.
    const original =
      kind === "retryable" && typeof error === "object" && error !== null && "cause" in error
        ? error.cause
        : error;
    return {
      fatal: original instanceof FatalError,
      retryable: original instanceof RetryableError,
      retryAfter: original instanceof RetryableError ? original.retryAfter.toISOString() : null,
    };
  }
  throw new Error("The step must fail");
}

export async function retryAfterWorkflow() {
  "use workflow";

  const now = Date.now();
  return [
    new RetryableError("Default delay"),
    new RetryableError("Duration", { retryAfter: "5s" }),
    new RetryableError("Milliseconds", { retryAfter: 2_500 }),
    new RetryableError("Date", { retryAfter: new Date(now + 10_000) }),
  ].map((error) => error.retryAfter?.getTime() - now);
}
