import type { MemoryScopeContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

/**
 * Scopes memory to the current human caller.
 *
 * @param ctx - Trusted session authentication supplied by eve.
 * @returns eve's per-principal scope for a person or local development, otherwise null.
 * @remarks Service principals, such as Slack Workflows and other bots, get no memory, so text a bot posts cannot save preferences that later turns recall. Human scopes match `byPrincipal`, so existing preferences keep their storage key.
 */
export const byHumanPrincipal = (ctx: MemoryScopeContext): string | null =>
  ctx.session.auth.current?.principalType === "service"
    ? null
    : byPrincipal(ctx);
