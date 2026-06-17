import {
  getRuntimeCompiledArtifactsAppRoot,
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { toErrorMessage } from "#shared/errors.js";

import { prewarmAppSandboxes } from "./prewarm.js";

const MAX_RETAINED_PREWARM_LOGS = 50;

interface DevelopmentPrewarmRecord {
  readonly logs: string[];
  promise: Promise<void>;
  readonly subscribers: Set<(message: string) => void>;
}

const pendingDevelopmentPrewarms = new Map<string, DevelopmentPrewarmRecord>();
const retainedDevelopmentPrewarmLogs = new Map<string, readonly string[]>();
const completedDevelopmentPrewarmSignatures = new Map<string, string>();

export function startDevelopmentSandboxPrewarmInBackground(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly log?: (message: string) => void;
}): void {
  const keys = resolvePrewarmKeys(input);
  const existing = findPendingPrewarm(keys);
  if (existing !== undefined) {
    registerPrewarmAliases(keys, existing);
    return;
  }

  const record: DevelopmentPrewarmRecord = {
    logs: [],
    promise: Promise.resolve(),
    subscribers: new Set(),
  };
  for (const key of keys) {
    retainedDevelopmentPrewarmLogs.delete(key);
  }
  const signatureCacheKey = resolvePrewarmSignatureCacheKey(input);
  const promise = prewarmAppSandboxes({
    appRoot: input.appRoot,
    compiledArtifactsSource: input.compiledArtifactsSource,
    log: (message) => recordPrewarmLog(record, message, input.log),
    onPrewarmSignature: (signature) => {
      completedDevelopmentPrewarmSignatures.set(signatureCacheKey, signature);
    },
    shouldPrewarmSignature: (signature) =>
      completedDevelopmentPrewarmSignatures.get(signatureCacheKey) !== signature,
  });
  record.promise = promise;
  registerPrewarmAliases(keys, record);

  void promise
    .catch((error) => {
      recordPrewarmLog(
        record,
        `eve: failed to initialize sandbox templates in the background: ${toErrorMessage(error)}`,
        input.log,
      );
    })
    .finally(() => {
      for (const key of keys) {
        if (pendingDevelopmentPrewarms.get(key) === record) {
          pendingDevelopmentPrewarms.delete(key);
        }
        if (record.subscribers.size === 0 && record.logs.length > 0) {
          retainedDevelopmentPrewarmLogs.set(key, [...record.logs]);
        }
      }
    });
}

export function subscribeDevelopmentSandboxPrewarmLogs(input: {
  readonly appRoot: string;
  readonly log: (message: string) => void;
}): () => void {
  const pending = findPendingPrewarm([input.appRoot]);
  if (pending !== undefined) {
    for (const message of pending.logs) {
      input.log(message);
    }
    pending.subscribers.add(input.log);
    return () => pending.subscribers.delete(input.log);
  }

  const retainedLogs = retainedDevelopmentPrewarmLogs.get(input.appRoot);
  if (retainedLogs === undefined) {
    return () => {};
  }

  retainedDevelopmentPrewarmLogs.delete(input.appRoot);
  for (const message of retainedLogs) {
    input.log(message);
  }
  return () => {};
}

export async function waitForDevelopmentSandboxPrewarm(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const pending = findPendingPrewarm(resolvePrewarmKeys(input));
  if (pending === undefined) {
    return;
  }

  let unsubscribe: (() => void) | undefined;
  if (input.log !== undefined) {
    for (const message of pending.logs) {
      input.log(message);
    }
    const subscriber = (message: string) => input.log?.(message);
    pending.subscribers.add(subscriber);
    unsubscribe = () => pending.subscribers.delete(subscriber);
  }

  try {
    await withProgressHeartbeat(
      "waiting for background sandbox template prewarm",
      input.log,
      () => pending.promise,
    );
  } finally {
    unsubscribe?.();
  }
}

function resolvePrewarmKeys(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): readonly string[] {
  const keys = new Set<string>([input.appRoot]);
  const compiledAppRoot = getRuntimeCompiledArtifactsAppRoot(input.compiledArtifactsSource);
  if (compiledAppRoot !== undefined) {
    keys.add(compiledAppRoot);
  }
  const sandboxAppRoot = getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource);
  if (sandboxAppRoot !== undefined) {
    keys.add(sandboxAppRoot);
  }
  return [...keys];
}

function resolvePrewarmSignatureCacheKey(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): string {
  return getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? input.appRoot;
}

function findPendingPrewarm(keys: readonly string[]): DevelopmentPrewarmRecord | undefined {
  for (const key of keys) {
    const record = pendingDevelopmentPrewarms.get(key);
    if (record !== undefined) {
      return record;
    }
  }
  return undefined;
}

function registerPrewarmAliases(keys: readonly string[], record: DevelopmentPrewarmRecord): void {
  for (const key of keys) {
    pendingDevelopmentPrewarms.set(key, record);
  }
}

function recordPrewarmLog(
  record: DevelopmentPrewarmRecord,
  message: string,
  log: ((message: string) => void) | undefined,
): void {
  record.logs.push(message);
  if (record.logs.length > MAX_RETAINED_PREWARM_LOGS) {
    record.logs.splice(0, record.logs.length - MAX_RETAINED_PREWARM_LOGS);
  }
  log?.(message);
  for (const subscriber of record.subscribers) {
    subscriber(message);
  }
}

async function withProgressHeartbeat<T>(
  message: string,
  log: ((message: string) => void) | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (log === undefined) {
    return await callback();
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    log(`${message} (${elapsedSeconds}s elapsed)`);
  }, 10_000);
  timer.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(timer);
  }
}
