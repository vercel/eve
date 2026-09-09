import type { ComputeLimits } from "#compute/limits.js";
import type { CellDefinition, Counter, LeaseToken, WireValue } from "#compute/protocol.js";
import type { ComputeStorage } from "#compute/storage/types.js";

export type { LeaseToken };

export interface PreparedCellTransition {
  expectedRevision: Counter;
  messageId: string;
  namespaceId: string;
  token: LeaseToken;
  transition: WireValue;
}

export interface CellCommitCommand {
  commandSequence: Counter;
  requestId: string;
}

export interface CellCommitResult {
  control: "continue" | "release";
  revision: Counter;
}

export interface PrepareCellTransitionInput<S, M> {
  cpuBudgetMs?: number;
  definition: CellDefinition<S, M>;
  definitionId: string;
  limits?: ComputeLimits;
  namespaceId: string;
  storage: ComputeStorage;
  token: LeaseToken;
}
