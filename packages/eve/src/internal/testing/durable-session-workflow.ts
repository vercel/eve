/**
 * Test fixture exercising the `createDurableSessionState` /
 * `readDurableSession` round-trip from inside a real workflow runtime.
 * The workflow test-time bundle builder discovers this directory.
 */
import type { ModelMessage } from "ai";

import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import type { HarnessSession } from "#harness/types.js";

/** Synthetic minimal session for storage-layer round-trips. */
function buildSyntheticSession(input: {
  sessionId: string;
  marker: string;
  historyDepth: number;
}): HarnessSession {
  const history: ModelMessage[] = Array.from({ length: input.historyDepth }, (_, index) => ({
    content: `${input.marker} message ${index}`,
    role: "user",
  }));

  return {
    agent: {
      compactionModelReference: { id: "test", contextWindowTokens: 1_000_000 },
      modelReference: { id: "test", contextWindowTokens: 1_000_000 },
      system: input.marker,
      tools: [],
    },
    compaction: {
      recentWindowSize: 0,
      threshold: 0.7,
    },
    continuationToken: `test:${input.sessionId}`,
    history,
    sessionId: input.sessionId,
  };
}

/** Writes one synthetic snapshot into the returned durable state. */
export async function durableSessionWriteStep(input: {
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}): Promise<DurableSessionState> {
  "use step";

  const session = buildSyntheticSession({
    historyDepth: input.historyDepth,
    marker: input.marker,
    sessionId: input.sessionId,
  });

  return createDurableSessionState({ session });
}

/**
 * Writes a synthetic snapshot **after** the first attempt throws.
 * Verifies the retry's returned state, not the seed state, is what
 * the next read sees.
 */
export async function durableSessionWriteWithRetryStep(input: {
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}): Promise<{ readonly attempt: number; readonly sessionState: DurableSessionState }> {
  "use step";

  const meta = getStepMetadata();

  if (meta.attempt === 1) {
    throw new Error("durable-session-write-with-retry: intentional first-attempt failure");
  }

  const session = buildSyntheticSession({
    historyDepth: input.historyDepth,
    marker: input.marker,
    sessionId: input.sessionId,
  });

  const sessionState = createDurableSessionState({ session });

  return { attempt: meta.attempt, sessionState };
}

/** Reads the latest snapshot and projects the fields the test asserts on. */
export async function durableSessionReadStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}> {
  "use step";

  const durable = await readDurableSession(input.sessionState);

  return {
    historyDepth: durable.history.length,
    marker: durable.agent.system,
    sessionId: durable.sessionId,
  };
}

/**
 * Drives a deterministic write/read sequence and returns each read's
 * outcome. `sessionId` comes from `workflowRunId` to mirror production
 * session identity.
 */
export interface DurableSessionStoreFixtureInput {
  readonly markers: readonly { readonly marker: string; readonly historyDepth: number }[];
}

export interface DurableSessionStoreFixtureResult {
  readonly sessionId: string;
  readonly readsAfterEachWrite: readonly {
    readonly marker: string;
    readonly historyDepth: number;
    readonly sessionId: string;
  }[];
  readonly tailReadAfterAllWrites: {
    readonly marker: string;
    readonly historyDepth: number;
    readonly sessionId: string;
  };
}

export async function durableSessionStoreFixtureWorkflow(
  input: DurableSessionStoreFixtureInput,
): Promise<DurableSessionStoreFixtureResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();

  const readsAfterEachWrite: {
    marker: string;
    historyDepth: number;
    sessionId: string;
  }[] = [];
  let currentState: DurableSessionState | undefined;

  for (const entry of input.markers) {
    currentState = await durableSessionWriteStep({
      historyDepth: entry.historyDepth,
      marker: entry.marker,
      sessionId,
    });
    const read = await durableSessionReadStep({ sessionState: currentState });
    readsAfterEachWrite.push(read);
  }

  if (currentState === undefined) {
    throw new Error("durable-session-store fixture requires at least one marker");
  }

  const tailReadAfterAllWrites = await durableSessionReadStep({ sessionState: currentState });

  return {
    readsAfterEachWrite,
    sessionId,
    tailReadAfterAllWrites,
  };
}

/** Forces a write-step retry and reads back the retry's returned state. */
export interface DurableSessionRetryFixtureResult {
  readonly sessionId: string;
  readonly writeAttempt: number;
  readonly readAfterRetry: {
    readonly marker: string;
    readonly historyDepth: number;
    readonly sessionId: string;
  };
}

export async function durableSessionRetryFixtureWorkflow(): Promise<DurableSessionRetryFixtureResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();

  // Seed write mirrors production, where `createSessionStep` always
  // creates the first durable session state before later turns run.
  await durableSessionWriteStep({
    historyDepth: 0,
    marker: "seed",
    sessionId,
  });

  const { attempt: writeAttempt, sessionState } = await durableSessionWriteWithRetryStep({
    historyDepth: 9,
    marker: "after-retry",
    sessionId,
  });

  const readAfterRetry = await durableSessionReadStep({ sessionState });

  return {
    readAfterRetry,
    sessionId,
    writeAttempt,
  };
}
