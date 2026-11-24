import { defineDynamic } from "eve/instructions";

import extension from "../extension.ts";
import { buildKeyedInstructions } from "../lib/project-instructions.ts";
import { discoverWorkspaceReadOnly, findKnownEnclosingRoot } from "../lib/repo-reconcile.ts";
import {
  initialRepositorySessionState,
  repoState,
  type RepositorySessionState,
} from "../lib/repo-state.ts";
import { resolveRepositoriesConfig } from "../lib/repositories.ts";

function readState(): RepositorySessionState {
  try {
    return repoState.get();
  } catch {
    return initialRepositorySessionState();
  }
}

export default defineDynamic(async (ctx) => {
  if (ctx.turn === null) return null;

  const resolved = resolveRepositoriesConfig(extension.config.repositories);
  const state = readState();

  if (state.syncedTurnId === ctx.turn.id) {
    const workspaceCovered =
      state.workspaceRoot !== null &&
      (findKnownEnclosingRoot(state.workspaceRoot, state.byRoot) !== null ||
        state.workspaceRoot in state.scopes);
    return buildKeyedInstructions(
      {
        workspaceInstruction: workspaceCovered ? [] : state.workspaceInstruction,
        byRoot: state.byRoot,
        scopes: state.scopes,
      },
      resolved.maxTotalBytes,
    );
  }

  if (
    state.syncedTurnId === null &&
    state.workspaceRoot === null &&
    state.pendingReconcile === null
  ) {
    let fallback: Pick<
      RepositorySessionState,
      "workspaceRoot" | "workspaceInstruction" | "byRoot"
    > | null = null;
    try {
      if (resolved.discoverOnStart === "on-sandbox-use") {
        const startedSandbox = await ctx.getSandbox({ ifStarted: true });
        if (startedSandbox === null) return null;
        fallback = await ctx.memo(["turn-discover", ctx.turn.id], async () =>
          discoverWorkspaceReadOnly(startedSandbox, resolved),
        );
      } else {
        fallback = await ctx.memo(["turn-discover", ctx.turn.id], async () => {
          const sandbox = await ctx.getSandbox();
          return await discoverWorkspaceReadOnly(sandbox, resolved);
        });
      }
    } catch {
      fallback = null;
    }

    if (fallback === null) return null;
    const workspaceCovered =
      fallback.workspaceRoot !== null &&
      findKnownEnclosingRoot(fallback.workspaceRoot, fallback.byRoot) !== null;
    return buildKeyedInstructions(
      {
        workspaceInstruction: workspaceCovered ? [] : fallback.workspaceInstruction,
        byRoot: fallback.byRoot,
        scopes: state.scopes,
      },
      resolved.maxTotalBytes,
    );
  }

  const workspaceCovered =
    state.workspaceRoot !== null &&
    (findKnownEnclosingRoot(state.workspaceRoot, state.byRoot) !== null ||
      state.workspaceRoot in state.scopes);
  return buildKeyedInstructions(
    {
      workspaceInstruction: workspaceCovered ? [] : state.workspaceInstruction,
      byRoot: state.byRoot,
      scopes: state.scopes,
    },
    resolved.maxTotalBytes,
  );
});
