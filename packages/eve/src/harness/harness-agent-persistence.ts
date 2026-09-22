import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";

import type { HarnessSession } from "#harness/types.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";

const HARNESS_AGENT_SESSION_STATE_KEY = "eve.harness.agentSession";

export interface PersistedHarnessAgentSession {
  readonly version: 1;
  readonly sessionId: string;
  readonly resumeFrom: HarnessAgentResumeSessionState;
}

export function getPersistedHarnessAgentSession(input: {
  readonly session: HarnessSession;
}): PersistedHarnessAgentSession | undefined {
  const value = input.session.state?.[HARNESS_AGENT_SESSION_STATE_KEY];
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isNonEmptyString(value.sessionId) ||
    !isHarnessAgentResumeSessionState(value.resumeFrom)
  ) {
    throw new Error("Unsupported persisted HarnessAgent session state.");
  }
  return value as unknown as PersistedHarnessAgentSession;
}

export function setPersistedHarnessAgentSession(input: {
  readonly persistence: PersistedHarnessAgentSession;
  readonly session: HarnessSession;
}): HarnessSession {
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [HARNESS_AGENT_SESSION_STATE_KEY]: input.persistence,
    },
  };
}

function isHarnessAgentResumeSessionState(value: unknown): value is HarnessAgentResumeSessionState {
  return (
    isObject(value) &&
    value.type === "resume-session" &&
    isNonEmptyString(value.harnessId) &&
    value.specificationVersion === "harness-v1" &&
    Object.hasOwn(value, "data")
  );
}
