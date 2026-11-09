import { contextStorage } from "#context/container.js";

/**
 * Whether a step's tool calls run at once or one at a time. With AsyncLocalStorage each call keeps
 * its own context, so they run in parallel. Without it (browsers, Web Workers; see
 * `context/scope-storage.ts`) the realm has one current scope, which only scopes that nest in time
 * keep sound, so calls run one at a time.
 */
export type ToolConcurrency = "parallel" | "sequential";

export function toolConcurrency(): ToolConcurrency {
  return contextStorage.kind === "async-local-storage" ? "parallel" : "sequential";
}

/**
 * Starts `run` for each item: all at once, or each after the previous one settles. Either way it
 * returns one promise per item, in order, for `Promise.all` or `Promise.allSettled`.
 */
export function startEach<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R>[] {
  if (toolConcurrency() === "parallel") return items.map(run);
  const started: Promise<R>[] = [];
  let previous: Promise<unknown> = Promise.resolve();
  for (const item of items) {
    const next = previous.then(() => run(item));
    previous = next.catch(() => undefined);
    started.push(next);
  }
  return started;
}
