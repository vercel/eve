/**
 * Sets environment variables in a running dev worker. Workers copy
 * `process.env` when they start, so a value the dev server learns later reaches
 * an already running worker only through this message.
 */
export const DEVELOPMENT_WORKER_ENVIRONMENT_EVENT = "eve:dev-worker-environment";

export interface DevelopmentWorkerEnvironmentMessage {
  readonly environment: Readonly<Record<string, string>>;
  readonly event: typeof DEVELOPMENT_WORKER_ENVIRONMENT_EVENT;
}

export function applyDevelopmentWorkerEnvironmentMessage(message: unknown): void {
  const candidate = message as Partial<DevelopmentWorkerEnvironmentMessage> | null;
  if (candidate?.event !== DEVELOPMENT_WORKER_ENVIRONMENT_EVENT) return;
  Object.assign(process.env, candidate.environment);
}
