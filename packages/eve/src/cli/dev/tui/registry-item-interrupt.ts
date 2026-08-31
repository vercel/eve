import { WizardCancelledError } from "#setup/step.js";

interface InterruptSource {
  waitForInterrupt(): { promise: Promise<void>; dispose(): void };
}

/** Runs one registry item behind an Esc trap that does not abort the surrounding batch. */
export async function runInterruptibleRegistryItem<T>(input: {
  parentSignal: AbortSignal;
  source: InterruptSource;
  task(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.parentSignal, controller.signal]);
  const interrupt = input.source.waitForInterrupt();
  const interrupted = Symbol("item-interrupted");
  const execution = input.task(signal);
  try {
    const result = await Promise.race([execution, interrupt.promise.then(() => interrupted)]);
    if (result !== interrupted) return result as T;
    controller.abort(new WizardCancelledError());
    try {
      await execution;
    } catch {
      // The item cancellation is represented by the wizard error below.
    }
    throw new WizardCancelledError();
  } finally {
    interrupt.dispose();
  }
}
