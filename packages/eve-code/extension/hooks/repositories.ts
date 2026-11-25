import { call } from "eve/events";
import { defineHook } from "eve/hooks";
import type { RuntimeSandboxSession } from "eve/sandbox";

import extension from "../extension.ts";
import {
  classifySettledCall,
  collectPendingExtraPaths,
  extractBackgroundBashJob,
  hasUncheckedFileAncestors,
  isBackgroundBashOutput,
  mergeExtraPaths,
  reconcileTouchedFile,
  reconcileWorkspace,
  upsertPendingBackgroundJob,
} from "../lib/repo-reconcile.ts";
import { repoState } from "../lib/repo-state.ts";
import { resolveRepositoriesConfig } from "../lib/repositories.ts";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const resolved = resolveRepositoriesConfig(extension.config.repositories);
      const state = repoState.get();
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
      const ruleCtx = {
        sandbox,
        session: ctx.session,
        channel: ctx.channel,
        trigger: "turn.started" as const,
        ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
      };
      const pendingJobs = state.pendingReconcile?.jobs ?? [];
      await reconcileWorkspace(sandbox, resolved, ruleCtx, {
        turnId: ctx.turn?.id ?? null,
        extraPaths: collectPendingExtraPaths(state.pendingReconcile),
        pendingJobs,
      });
    },

    async "call.settled"(event, ctx) {
      const observed = call(ctx.view, event.data.callId);
      if (observed?.kind !== "tool" || observed.state !== "completed") return;

      const resolved = resolveRepositoriesConfig(extension.config.repositories);
      const state = repoState.get();
      const action = classifySettledCall(observed, state, resolved.syncAfter);
      const turnId = ctx.turn?.id ?? null;

      if (
        action.kind === "reconcile" &&
        observed.name === "bash" &&
        isBackgroundBashOutput(observed.output)
      ) {
        const job = extractBackgroundBashJob(observed.output, action.extraPaths);
        if (job !== null) {
          repoState.update((latest) => ({
            ...latest,
            pendingReconcile: {
              jobs: upsertPendingBackgroundJob(latest.pendingReconcile?.jobs ?? [], job),
            },
          }));
        }
        return;
      }

      const needsTurnSync = turnId !== null && state.syncedTurnId !== turnId;
      const pendingJobs = state.pendingReconcile?.jobs ?? [];
      const hasPending = pendingJobs.length > 0;

      if (!needsTurnSync && !hasPending) {
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

      let sandbox: RuntimeSandboxSession | null = null;
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

      if (needsTurnSync || hasPending || action.kind === "reconcile") {
        const extraPaths = mergeExtraPaths(
          collectPendingExtraPaths(state.pendingReconcile),
          action.kind === "reconcile" ? action.extraPaths : [],
        );
        await reconcileWorkspace(sandbox, resolved, ruleCtx, {
          turnId: needsTurnSync ? turnId : undefined,
          extraPaths,
          pendingJobs,
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
