import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import {
  dispatchSessionSteps,
  sessionStepCalls,
  type SessionStepRunner,
} from "#execution/session/steps.js";

function unavailable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`The "${name}" step is not part of these test steps.`);
  };
}

export function sharedSessionSteps(sessionId = "session-test"): SessionStepRunner {
  return {
    host: {
      step: dispatchSessionSteps({
        ...SHARED_SESSION_STEPS,
        turn: unavailable("turn"),
        dispatchRuns: unavailable("dispatchRuns"),
        applyRunMessages: unavailable("applyRunMessages"),
      }),
    },
    stepCall: sessionStepCalls(sessionId),
  };
}
