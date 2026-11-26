import { defineDynamic } from "eve/instructions";

import extension from "../extension.ts";
import { buildKeyedInstructions } from "../lib/project-instructions.ts";
import { isWorkspaceCovered } from "../lib/repo-reconcile.ts";
import { initialRepositorySessionState, repoState } from "../lib/repo-state.ts";
import { resolveRepositoriesConfig } from "../lib/repositories.ts";

export default defineDynamic((ctx) => {
  if (ctx.turn === null) return null;
  const resolved = resolveRepositoriesConfig(extension.config.repositories);
  let state = initialRepositorySessionState();
  try {
    state = repoState.get();
  } catch {}
  const workspaceCovered = isWorkspaceCovered(state.workspaceRoot, state.byRoot, state.scopes);
  return buildKeyedInstructions(
    {
      workspaceInstruction: workspaceCovered ? [] : state.workspaceInstruction,
      byRoot: state.byRoot,
      scopes: state.scopes,
      overflowPaths: state.overflowPaths,
    },
    resolved.maxTotalBytes,
  );
});
