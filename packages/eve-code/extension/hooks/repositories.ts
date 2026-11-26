import { call } from "eve/events";
import { defineHook } from "eve/hooks";
import type { RuntimeSandboxSession } from "eve/sandbox";

import extension from "../extension.ts";
import {
  classifySettledCall,
  hasUncheckedFileAncestors,
  isBackgroundBashOutput,
  reconcileTouchedFile,
  reconcileWorkspace,
} from "../lib/repo-reconcile.ts";
import { repoState } from "../lib/repo-state.ts";
import { resolveRepositoriesConfig } from "../lib/repositories.ts";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const resolved = resolveRepositoriesConfig(extension.config.repositories);
      let sandbox: RuntimeSandboxSession | null;
      try {
        sandbox =
          resolved.discoverOnStart === "on-sandbox-use"
            ? await ctx.getSandbox({ create: false })
            : await ctx.getSandbox();
      } catch {
        return;
      }
      if (sandbox === null) return;
      await reconcileWorkspace(
        sandbox,
        resolved,
        {
          sandbox,
          session: ctx.session,
          channel: ctx.channel,
          trigger: "turn.started",
          ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
        },
        { turnId: ctx.turn?.id ?? null },
      );
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

      let sandbox: RuntimeSandboxSession | null;
      try {
        sandbox = await ctx.getSandbox({ create: false });
      } catch {
        return;
      }
      if (sandbox === null) return;

      const ruleCtx = {
        sandbox,
        session: ctx.session,
        channel: ctx.channel,
        trigger: "call.settled" as const,
        ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
      };

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
