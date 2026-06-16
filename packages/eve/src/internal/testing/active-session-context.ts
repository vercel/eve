import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  SandboxKey,
  type Session,
  SessionKey,
  type SessionParent,
  type SessionTurn,
} from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import type { SandboxAccess } from "#sandbox/state.js";

/**
 * Seed values used by {@link runWithActiveSessionContext} to set up a test
 * session context.
 *
 * Kept separate from the public `RunAsSessionInit` so the AppHarness can
 * depend on a narrow, internal interface without re-exporting mock types
 * from this module.
 */
export interface ActiveSessionInit {
  readonly sessionId: string;
  readonly turn: SessionTurn;
  readonly parent?: SessionParent;
  readonly sandbox?: SandboxAccess;
  /**
   * Optional channel adapter to bind in the active channel context. Used by
   * staging-layer integration tests that exercise the attachment ref
   * dispatch — the production runtime always sets this via
   * `runtime-context.ts`, but tests that bypass the full runtime need
   * to seed it explicitly.
   */
  readonly channel?: ChannelAdapter;
}

/**
 * Builds a {@link ContextContainer} seeded with the values described by
 * `init`. Exposed for tests that need direct control over the container.
 */
export function buildActiveSessionContext(init: ActiveSessionInit): ContextContainer {
  const ctx = new ContextContainer();

  const session: Session = buildSession(init);
  ctx.set(SessionKey, session);

  if (init.sandbox !== undefined) {
    ctx.set(SandboxKey, init.sandbox);
  }

  if (init.channel !== undefined) {
    setChannelContext(ctx, init.channel);
  }

  return ctx;
}

function buildSession(init: ActiveSessionInit): Session {
  if (init.parent === undefined) {
    return {
      auth: { current: null, initiator: null },
      sessionId: init.sessionId,
      turn: init.turn,
    };
  }

  return {
    auth: { current: null, initiator: null },
    parent: init.parent,
    sessionId: init.sessionId,
    turn: init.turn,
  };
}

/**
 * Runs `fn` with an eve {@link ContextContainer} bound to the active
 * async scope.
 */
export async function runWithActiveSessionContext<T>(
  init: ActiveSessionInit,
  fn: () => Promise<T> | T,
): Promise<T> {
  const ctx = buildActiveSessionContext(init);
  return await contextStorage.run(ctx, async () => await fn());
}
