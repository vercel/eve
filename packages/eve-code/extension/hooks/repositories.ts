import { call } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import type { RuntimeSandboxSession } from "eve/sandbox";

import extension, { type RepositoryRuleContext } from "../extension.ts";
import {
  classifySettledCall,
  hasUncheckedFileAncestors,
  isBackgroundBashOutput,
  reconcileTouchedFile,
  reconcileWorkspace,
} from "../lib/repo-reconcile.ts";
import { repoState } from "../lib/repo-state.ts";
import { resolveRepositoriesConfig } from "../lib/repositories.ts";

async function openSandbox(
  ctx: Pick<HookContext, "getSandbox">,
  create: boolean,
): Promise<RuntimeSandboxSession | null> {
  try {
    return create ? await ctx.getSandbox() : await ctx.getSandbox({ create: false });
  } catch {
    return null;
  }
}

function buildRuleContext(
  sandbox: RuntimeSandboxSession,
  ctx: Pick<HookContext, "session" | "channel" | "conversation">,
  trigger: RepositoryRuleContext["trigger"],
): RepositoryRuleContext {
  return {
    sandbox,
    session: ctx.session,
    channel: ctx.channel,
    trigger,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
  };
}

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const resolved = resolveRepositoriesConfig(extension.config.repositories);
      const sandbox = await openSandbox(ctx, resolved.discoverOnStart !== "on-sandbox-use");
      if (sandbox === null) return;
      await reconcileWorkspace(sandbox, resolved, buildRuleContext(sandbox, ctx, "turn.started"), {
        turnId: ctx.turn?.id ?? null,
      });
    },

    async "call.settled"(event, ctx) {
      const observed = call(ctx.view, event.data.callId);
      if (observed?.kind !== "tool" || observed.state !== "completed") return;
      if (observed.name === "bash" && isBackgroundBashOutput(observed.output)) return;

      const resolved = resolveRepositoriesConfig(extension.config.repositories);
      const state = repoState.get();
      const action = classifySettledCall(observed, state, resolved.syncAfter);
      const turnId = ctx.turn?.id ?? null;
      const needsTurnSync = turnId !== null && state.syncedTurnId !== turnId;

      if (!needsTurnSync) {
        if (action.kind === "none") return;
        if (
          action.kind === "file" &&
          !hasUncheckedFileAncestors(
            action.targetPath,
            action.isDirectory,
            state,
            resolved.scopedInstructions,
          )
        ) {
          return;
        }
      }

      const sandbox = await openSandbox(ctx, false);
      if (sandbox === null) return;

      const ruleCtx = buildRuleContext(sandbox, ctx, "call.settled");

      if (needsTurnSync || action.kind === "reconcile") {
        await reconcileWorkspace(sandbox, resolved, ruleCtx, {
          turnId: needsTurnSync ? turnId : undefined,
          extraPaths: action.kind === "reconcile" ? action.extraPaths : [],
        });
      }

      if (action.kind === "file") {
        const updated = repoState.get();
        if (
          hasUncheckedFileAncestors(
            action.targetPath,
            action.isDirectory,
            updated,
            resolved.scopedInstructions,
          )
        ) {
          await reconcileTouchedFile(sandbox, action.targetPath, resolved, ruleCtx);
        }
      }
    },
  },
});
