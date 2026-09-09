import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "#shared/shell-quote.js";

import type { PreparedSelfModificationWorkspace } from "./git-workspace.js";
import { gitOutput, runGitCommand } from "./git.js";
import { assertFullSha } from "./identifiers.js";

export const MAX_PROPOSAL_CHANGED_BYTES = 1_000_000;
export const MAX_PROPOSAL_CHANGED_FILES = 100;

export interface ProposalChange {
  readonly bytes: number;
  readonly kind: "add" | "delete" | "modify";
  readonly mode: "100644" | "100755" | null;
  readonly objectId: string | null;
  readonly path: string;
}

export interface SelfModificationProposal {
  readonly baseSha: string;
  readonly baseTreeSha: string;
  readonly changedBytes: number;
  readonly changes: readonly ProposalChange[];
  readonly proposedTreeSha: string;
}

type ProposalSandbox = Pick<SandboxSession, "run">;

/** Captures and validates the worktree before any publication credential is resolved. */
export async function captureSelfModificationProposal(input: {
  readonly sandbox: ProposalSandbox;
  readonly workspace: PreparedSelfModificationWorkspace;
}): Promise<SelfModificationProposal> {
  const repository = quote(input.workspace.repositoryPath);
  assertFullSha(input.workspace.baseSha, "proposal base revision");
  await runGitCommand(input.sandbox, `git -C ${repository} add -A -- .`);
  const proposedTreeSha = await gitOutput(input.sandbox, `git -C ${repository} write-tree`);
  const baseTreeSha = await gitOutput(
    input.sandbox,
    `git -C ${repository} rev-parse ${quote(`${input.workspace.baseSha}^{tree}`)}`,
  );
  assertFullSha(proposedTreeSha, "proposal tree");
  assertFullSha(baseTreeSha, "proposal base tree");
  const raw = await gitOutput(
    input.sandbox,
    `git -C ${repository} diff-tree -r --no-commit-id --raw -z --no-renames ${quote(input.workspace.baseSha)} ${quote(proposedTreeSha)}`,
    false,
  );
  const records = parseRawDiff(raw);
  if (records.length === 0) throw new Error("Self-modification proposal contains no changes.");
  if (records.length > MAX_PROPOSAL_CHANGED_FILES) {
    throw new Error(
      `Self-modification proposal changes ${records.length} files; limit is ${MAX_PROPOSAL_CHANGED_FILES}.`,
    );
  }

  const changes: ProposalChange[] = [];
  let changedBytes = 0;
  for (const record of records) {
    const mode = record.status === "D" ? null : proposalMode(record.newMode, record.path);
    const objectId = record.status === "D" ? null : record.newObjectId;
    assertAllowedChange({ mode, objectId, path: record.path }, input.workspace.directory);
    const bytes =
      objectId === null
        ? 0
        : await blobSize(input.sandbox, input.workspace.repositoryPath, objectId);
    changedBytes += bytes;
    if (changedBytes > MAX_PROPOSAL_CHANGED_BYTES) {
      throw new Error(
        `Self-modification proposal changes more than ${MAX_PROPOSAL_CHANGED_BYTES} bytes.`,
      );
    }
    changes.push({
      bytes,
      kind: record.status === "A" ? "add" : record.status === "D" ? "delete" : "modify",
      mode,
      objectId,
      path: record.path,
    });
  }
  return { baseSha: input.workspace.baseSha, baseTreeSha, changedBytes, changes, proposedTreeSha };
}

/** Reads an already captured blob and verifies its Git object id before upload. */
export async function readProposalBlob(input: {
  readonly change: ProposalChange;
  readonly sandbox: ProposalSandbox;
  readonly workspace: PreparedSelfModificationWorkspace;
}): Promise<string> {
  if (input.change.objectId === null) throw new Error("Cannot read a deleted proposal blob.");
  const base64 = await gitOutput(
    input.sandbox,
    `git -C ${quote(input.workspace.repositoryPath)} cat-file blob ${quote(input.change.objectId)} | base64 | tr -d '\\n'`,
  );
  const bytes = Buffer.from(base64, "base64");
  const objectId = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.byteLength !== input.change.bytes || objectId !== input.change.objectId.toLowerCase()) {
    throw new Error(
      `Self-modification proposal blob changed after validation: ${JSON.stringify(input.change.path)}.`,
    );
  }
  return base64;
}

interface RawChange {
  readonly newMode: string;
  readonly newObjectId: string;
  readonly path: string;
  readonly status: "A" | "D" | "M";
}

export function parseRawDiff(raw: string): readonly RawChange[] {
  if (raw.length === 0) return [];
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git returned malformed raw diff output.");
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index];
    const path = fields[index + 1];
    const match =
      metadata === undefined
        ? null
        : /^:[0-7]{6} ([0-7]{6}) [a-f0-9]{40} ([a-f0-9]{40}) ([ADM])$/u.exec(metadata);
    if (match === null || path === undefined || !isSafePath(path))
      throw new Error("Git returned malformed raw diff output.");
    changes.push({
      newMode: match[1]!,
      newObjectId: match[2]!,
      path,
      status: match[3]! as RawChange["status"],
    });
  }
  return changes;
}

export function assertAllowedChange(
  change: Pick<ProposalChange, "mode" | "objectId" | "path">,
  directory: string,
): void {
  const path = change.path;
  const appRoot = directory === "." ? "" : `${directory}/`;
  const agentRoot = `${appRoot}agent/`;
  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  if (
    !isSafePath(path) ||
    parts.includes(".git") ||
    basename === ".env" ||
    basename === ".envrc" ||
    basename.startsWith(".env.") ||
    parts.some((part) =>
      [
        "node_modules",
        "dist",
        "build",
        ".next",
        ".output",
        ".turbo",
        ".vercel",
        "coverage",
        "out",
      ].includes(part),
    ) ||
    path.startsWith(".github/workflows/") ||
    path.startsWith(`${agentRoot}subagents/self-modification/`) ||
    path === `${appRoot}agent/extensions/selfmod.ts` ||
    path === `${appRoot}agent/self-modification.config.ts`
  ) {
    throw new Error(
      `Self-modification proposal changes a protected path: ${JSON.stringify(path)}.`,
    );
  }
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\n") &&
    !path.includes("\r") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function proposalMode(mode: string, path: string): "100644" | "100755" {
  if (mode === "100644" || mode === "100755") return mode;
  throw new Error(
    `Self-modification proposal uses unsafe Git mode ${mode}: ${JSON.stringify(path)}.`,
  );
}

async function blobSize(
  sandbox: ProposalSandbox,
  repository: string,
  objectId: string,
): Promise<number> {
  assertFullSha(objectId, "proposal blob");
  const size = await gitOutput(
    sandbox,
    `git -C ${quote(repository)} cat-file -s ${quote(objectId)}`,
  );
  if (!/^\d+$/u.test(size) || !Number.isSafeInteger(Number(size)))
    throw new Error("Git returned an invalid blob size.");
  return Number(size);
}

function quote(value: string): string {
  return shellQuote(value);
}
