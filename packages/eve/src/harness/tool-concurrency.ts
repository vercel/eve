import { contextStorage } from "#context/container.js";

export type ToolConcurrency = "parallel" | "sequential";

export function toolConcurrency(): ToolConcurrency {
  return contextStorage.kind === "async-local-storage" ? "parallel" : "sequential";
}

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
