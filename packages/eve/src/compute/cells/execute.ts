import type {
  CellCommitCommand,
  CellCommitResult,
  PrepareCellTransitionInput,
} from "#compute/cells/types.js";
import { prepareCellTransition } from "#compute/cells/prepare.js";
import { ComputeError } from "#compute/errors.js";
import type { ComputeFailpoints } from "#compute/failpoints.js";
import { commitCellTransition, rejectCellHead } from "#compute/storage/transitions.js";

export interface ExecuteCellTransitionInput<S, M> extends PrepareCellTransitionInput<S, M> {
  command: CellCommitCommand;
  failpoints?: ComputeFailpoints;
}

export async function executeCellTransition<S, M>(
  input: ExecuteCellTransitionInput<S, M>,
): Promise<CellCommitResult> {
  const prepared = await prepareCellTransition(input);
  try {
    return await commitCellTransition({
      command: input.command,
      failpoints: input.failpoints,
      limits: input.limits,
      prepared,
      storage: input.storage,
    });
  } catch (error) {
    if (
      error instanceof ComputeError &&
      (error.code === "INVALID_INPUT" || error.code === "PAYLOAD_TOO_LARGE")
    ) {
      await rejectCellHead({
        error,
        expectedRevision: prepared.expectedRevision,
        messageId: prepared.messageId,
        namespaceId: prepared.namespaceId,
        storage: input.storage,
        token: prepared.token,
      });
    }
    throw error;
  }
}
