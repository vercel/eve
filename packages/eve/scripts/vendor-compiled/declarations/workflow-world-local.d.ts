import type { QueuePrefix, World } from "#compiled/@workflow/world/index.js";

export type LocalWorld = World & {
  clear(): Promise<void>;
  registerHandler(prefix: QueuePrefix, handler: (request: Request) => Promise<Response>): void;
  /**
   * Hands a run's steps that were running inline in a previous process back to
   * the queue before the run is re-enqueued. Since `@workflow/world-local` 5.2.0.
   */
  releaseOrphanedSteps?(runId: string): Promise<void>;
};

export function createWorld(options?: {
  readonly baseUrl?: string;
  readonly dataDir?: string;
  readonly recoverActiveRuns?: boolean;
  readonly streamFlushIntervalMs?: number;
  readonly tag?: string;
}): LocalWorld;
