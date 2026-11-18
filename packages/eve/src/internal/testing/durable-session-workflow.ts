import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  createDurableSessionValues,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";

const MARKER_KEY = "test.marker";

function buildSyntheticSession(input: {
  sessionId: string;
  marker: string;
  historyDepth: number;
}): HarnessSession {
  const history: HarnessSession["history"] = Array.from(
    { length: input.historyDepth },
    (_, index) => ({
      content: `${input.marker} message ${index}`,
      kind: "user",
      role: "user",
    }),
  );

  return {
    state: { [MARKER_KEY]: input.marker },
    compaction: {},
    continuationToken: `test:${input.sessionId}`,
    history,
    sessionId: input.sessionId,
  };
}

interface DurableSessionValues {
  readonly history: HarnessModelMessage[];
  readonly sessionState: DurableSessionState;
}

async function durableSessionWriteStep(input: {
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}): Promise<DurableSessionValues> {
  "use step";

  const session = buildSyntheticSession({
    historyDepth: input.historyDepth,
    marker: input.marker,
    sessionId: input.sessionId,
  });

  return createDurableSessionValues(session);
}

async function durableSessionWriteWithRetryStep(input: {
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}): Promise<{ readonly attempt: number; readonly values: DurableSessionValues }> {
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

  return { attempt: meta.attempt, values: createDurableSessionValues(session) };
}

async function durableSessionReadStep(input: DurableSessionValues): Promise<{
  readonly marker: string;
  readonly historyDepth: number;
  readonly sessionId: string;
}> {
  "use step";

  const durable = readDurableSession(input.sessionState);

  return {
    historyDepth: input.history.length,
    marker: String(durable.state?.[MARKER_KEY]),
    sessionId: durable.sessionId,
  };
}

interface DurableSessionStoreFixtureInput {
  readonly markers: readonly { readonly marker: string; readonly historyDepth: number }[];
}

interface DurableSessionStoreFixtureResult {
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
  let currentState: DurableSessionValues | undefined;

  for (const entry of input.markers) {
    currentState = await durableSessionWriteStep({
      historyDepth: entry.historyDepth,
      marker: entry.marker,
      sessionId,
    });
    const read = await durableSessionReadStep(currentState);
    readsAfterEachWrite.push(read);
  }

  if (currentState === undefined) {
    throw new Error("durable-session-store fixture requires at least one marker");
  }

  const tailReadAfterAllWrites = await durableSessionReadStep(currentState);

  return {
    readsAfterEachWrite,
    sessionId,
    tailReadAfterAllWrites,
  };
}

interface DurableSessionRetryFixtureResult {
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

  await durableSessionWriteStep({
    historyDepth: 0,
    marker: "seed",
    sessionId,
  });

  const { attempt: writeAttempt, values } = await durableSessionWriteWithRetryStep({
    historyDepth: 9,
    marker: "after-retry",
    sessionId,
  });

  const readAfterRetry = await durableSessionReadStep(values);

  return {
    readAfterRetry,
    sessionId,
    writeAttempt,
  };
}
