/**
 * Closed-contract dispatch surface between session-mutating step
 * bodies (latest deployment) and the durable driver workflow (pinned
 * to whichever deployment called `start()`).
 *
 * The driver matches on `kind` and follows a fixed playbook per arm.
 * Adding a new arm is breaking (pinned drivers can't dispatch an
 * unknown `kind`); adding optional fields inside an existing arm is
 * forward-compatible because the driver passes the action through by
 * reference and devalue preserves unknown POJO fields. Do not
 * destructure-and-rebuild a `NextDriverAction` — full destructuring
 * strips unknown fields.
 */
import type { DurableSessionState } from "#execution/durable-session-store.js";

/** Discriminated union the driver workflow body dispatches on. */
export type NextDriverAction =
  | {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    }
  | {
      readonly kind: "park";
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
      readonly authorizationNames?: readonly string[];
    }
  | {
      readonly kind: "dispatch-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    }
  | {
      readonly kind: "dispatch-code-mode-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    };
