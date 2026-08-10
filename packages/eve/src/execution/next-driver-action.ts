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
import type { SettledTurn } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Discriminated union the driver workflow body dispatches on. */
export type NextDriverAction =
  | {
      readonly kind: "done";
      readonly output: unknown;
      readonly isError?: boolean;
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
      /** Session-total token usage spent by the completed session. */
      readonly usage?: TokenUsage;
      /**
       * Usage the final turn added beyond what earlier settled turns already
       * reported; forwarded through the same pinned-driver-safe
       * optional-field pattern as `cancelled`.
       */
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly kind: "park";
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      /**
       * Set when the parked turn was cancelled: the driver runs
       * `settleCancelledTurnStep` before the normal park playbook. An
       * optional field rather than a new arm so pinned drivers keep
       * working.
       */
      readonly cancelled?: true;
      /**
       * Settled user-facing answer forwarded through the same pinned-driver-safe
       * optional-field pattern as `cancelled`.
       */
      readonly settled?: SettledTurn;
    }
  | {
      readonly kind: "dispatch-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    }
  | {
      readonly kind: "dispatch-workflow-runtime-actions";
      readonly pendingActionKeys: readonly string[];
      readonly sessionState: DurableSessionState;
      readonly serializedContext: Record<string, unknown>;
    };
