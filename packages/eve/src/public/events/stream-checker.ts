import {
  createStreamChecker as createConfiguredChecker,
  type StreamChecker,
} from "#protocol/session-events/checker.js";

/**
 * Checks a session stream against its lifecycle rules, one stored line at a time, from its
 * first line. It checks how facts relate, not their fields: records are read as their types
 * describe them.
 */
export function createStreamChecker(): StreamChecker {
  return createConfiguredChecker();
}
