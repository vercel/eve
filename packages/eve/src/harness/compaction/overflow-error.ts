/**
 * A summary request was longer than the summary model's context window. A strategy can catch it
 * from `ctx.summarize()`, drop part of what it sent, and summarize again.
 */
export class CompactionOverflowError extends Error {
  override readonly name = "CompactionOverflowError";

  constructor(options: { readonly cause: unknown }) {
    super("The summary request is longer than the summary model's context window.", options);
  }
}
