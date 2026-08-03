import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { defineState } from "eve/context";
import type { ApprovalContext } from "eve/tools/approval";
import type { SandboxSession } from "eve/sandbox";

import {
  PROPOSAL_REFERENCE_SCHEMA,
  type FinalizeEditsOutput,
  type ProposalInput,
  type ProposalReference,
} from "./edit-contracts.js";
import { formatSourceChanges, type SourceChange } from "./edit-review.js";

const SOURCE_ROOT = "/source";

type EditSandbox = Pick<SandboxSession, "readTextFile" | "removePath" | "writeTextFile">;
type SourceProposal = {
  readonly changes: readonly SourceChange[];
  readonly id: string;
  readonly summary: string;
};
type ProposalState = Readonly<Record<string, SourceProposal>>;

const proposals = defineState<ProposalState>("proposals", () => ({}));

function normalizeSourcePath(filePath: string): string {
  if (!filePath.startsWith("/")) {
    throw new Error(`Self-modification path must be absolute: ${filePath}`);
  }
  const normalized = posix.normalize(filePath);
  if (!normalized.startsWith(`${SOURCE_ROOT}/`)) {
    throw new Error(`Self-modification path must be under ${SOURCE_ROOT}: ${filePath}`);
  }
  return normalized;
}

function requirePendingProposal(proposalId: string): SourceProposal {
  const proposal = proposals.get()[proposalId];
  if (proposal === undefined) {
    throw new Error(`Unknown or expired edit proposal: ${proposalId}`);
  }
  return proposal;
}

/** Records a validated, immutable source proposal without changing any files. */
export async function proposeEdits(
  sandbox: EditSandbox,
  input: ProposalInput,
): Promise<ProposalReference> {
  const paths = new Set<string>();
  const normalizedPaths = input.edits.map((edit) => {
    const path = normalizeSourcePath(edit.filePath);
    if (paths.has(path)) {
      throw new Error(`A proposal may edit each file only once: ${path}`);
    }
    paths.add(path);
    return path;
  });
  const currentContents = await Promise.all(
    normalizedPaths.map((path) => sandbox.readTextFile({ path })),
  );
  const changes: SourceChange[] = input.edits.map((edit, index) => {
    const path = normalizedPaths[index]!;
    const current = currentContents[index] ?? null;
    if (edit.kind === "create") {
      if (current !== null) {
        throw new Error(`Cannot create ${path} because it already exists.`);
      }
      return [path, null, edit.content];
    }
    if (current === null) {
      throw new Error(`Cannot ${edit.kind} ${path} because it does not exist.`);
    }
    if (edit.kind === "delete") return [path, current, null];

    const first = current.indexOf(edit.oldText);
    const second = first < 0 ? -1 : current.indexOf(edit.oldText, first + edit.oldText.length);
    if (first < 0 || second >= 0) {
      throw new Error(
        `Expected oldText exactly once in ${path}, but found ${countOccurrences(current, edit.oldText)} occurrences.`,
      );
    }
    return [
      path,
      current,
      current.slice(0, first) + edit.newText + current.slice(first + edit.oldText.length),
    ];
  });

  const proposal: SourceProposal = {
    changes,
    id: randomUUID(),
    summary: input.summary,
  };
  proposals.update((current) => ({ ...current, [proposal.id]: proposal }));
  return { proposalId: proposal.id };
}

/** Requires approval only for a proposal that was validated and recorded in this session. */
export function requireProposalApproval(ctx: ApprovalContext<ProposalReference>) {
  try {
    const { proposalId } = PROPOSAL_REFERENCE_SCHEMA.parse(ctx.toolInput);
    const proposal = requirePendingProposal(proposalId);
    return {
      type: "user-approval" as const,
      content: {
        type: "text" as const,
        text: formatSourceChanges(proposal.changes),
      },
    };
  } catch (error) {
    return {
      type: "denied" as const,
      reason: error instanceof Error ? error.message : "The proposed edits cannot be reviewed.",
    };
  }
}

/** Applies the exact recorded transitions after the framework approval gate succeeds. */
export async function finalizeEdits(
  sandbox: EditSandbox,
  proposalId: string,
): Promise<FinalizeEditsOutput> {
  const proposal = requirePendingProposal(proposalId);
  const currentContents = await Promise.all(
    proposal.changes.map(([path]) => sandbox.readTextFile({ path })),
  );
  for (const [index, [path, before]] of proposal.changes.entries()) {
    if ((currentContents[index] ?? null) !== before) {
      throw new Error(
        `${path} changed after the edits were proposed. Inspect it and propose the edits again.`,
      );
    }
  }

  await applySourceChanges(sandbox, proposal.changes);

  proposals.update((current) => {
    const remaining = { ...current };
    delete remaining[proposalId];
    return remaining;
  });
  return {
    changedFiles: proposal.changes.map(([path]) => path),
    proposalId,
  };
}

async function applySourceChanges(
  sandbox: EditSandbox,
  changes: readonly SourceChange[],
): Promise<void> {
  const applied: SourceChange[] = [];
  try {
    for (const change of changes) {
      await writeSourceState(sandbox, change[0], change[2]);
      applied.push(change);
    }
  } catch (applyError) {
    const rollbackErrors: unknown[] = [];
    for (const [path, before] of applied.reverse()) {
      try {
        await writeSourceState(sandbox, path, before);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [applyError, ...rollbackErrors],
        "Applying source edits failed and the previous source state could not be fully restored.",
      );
    }
    throw applyError;
  }
}

async function writeSourceState(
  sandbox: EditSandbox,
  path: string,
  content: string | null,
): Promise<void> {
  if (content === null) {
    await sandbox.removePath({ path });
  } else {
    await sandbox.writeTextFile({ content, path });
  }
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}
