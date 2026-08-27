import { createHash } from "node:crypto";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

import {
  buildBrokerNetworkPolicy,
  gitOutput,
  runGitCommand,
  shellQuote,
  withBrokeredGitEgress,
} from "./git.js";
import { assertFullSha, assertGitRef, assertRepositoryPart } from "./identifiers.js";
export const SELF_MODIFICATION_CONFIG_PATH = "agent/subagents/self-modification/config.ts";

export const CHECKOUT_ROOT = "/workspace/self-modification";
export const REPOSITORY_PATH = `${CHECKOUT_ROOT}/repository`;
export const DEPLOYED_PATH = `${CHECKOUT_ROOT}/deployed`;
export const BASE_REF = "refs/eve-self-modification/base";
export const DEPLOYED_REF = "refs/eve-self-modification/deployed";
const INITIAL_FETCH_DEPTH = 50;
const MAX_FETCH_DEPTH = 1_000;
const MAX_CHANGED_BYTES = 1_000_000;
const MAX_CHANGED_FILES = 100;

export type SelfModificationCommandSandbox = Pick<SandboxSession, "run">;
export type SelfModificationCheckoutSandbox = Pick<SandboxSession, "run" | "setNetworkPolicy">;
export interface SelfModificationRepository {
  readonly owner: string;
  /** The branch against which the proposal is prepared. */
  readonly targetBranch: string;
  readonly repo: string;
}
export interface PreparedSelfModificationWorkspace {
  readonly baseSha: string;
  readonly deployedPath: string;
  readonly deployedSha: string;
  readonly repositoryPath: string;
  readonly rootDirectory: string;
}
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

/** Called once from the sandbox definition's once-per-live-session `onSession` hook. */
export async function prepareSelfModificationWorkspace(input: {
  readonly deployedSha: string;
  readonly token: string;
  readonly rootDirectory: string;
  readonly repository: SelfModificationRepository;
  readonly sandbox: SelfModificationCheckoutSandbox;
}): Promise<PreparedSelfModificationWorkspace> {
  assertFullSha(input.deployedSha, "deployed revision");
  assertRepositoryPart(input.repository.owner, "repository owner");
  assertRepositoryPart(input.repository.repo, "repository name");
  assertGitRef(input.repository.targetBranch);
  assertRootDirectory(input.rootDirectory);
  if (input.token.length === 0)
    throw new Error("Self-modification checkout requires a GitHub personal access token.");
  const remote = `https://github.com/${input.repository.owner}/${input.repository.repo}.git`;
  await withBrokeredGitEgress(
    input.sandbox,
    { policy: checkoutNetworkPolicy(input.token), restore: "deny-all" },
    async () => {
      await run(
        input.sandbox,
        `rm -rf ${quote(CHECKOUT_ROOT)} && mkdir -p ${quote(REPOSITORY_PATH)}`,
      );
      await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} init`);
      await run(
        input.sandbox,
        `git -C ${quote(REPOSITORY_PATH)} remote add origin ${quote(remote)}`,
      );
      await run(
        input.sandbox,
        `GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0 git -C ${quote(REPOSITORY_PATH)} fetch --no-tags --depth=${INITIAL_FETCH_DEPTH} origin ${quote(input.deployedSha)}`,
      );
      await run(
        input.sandbox,
        `git -C ${quote(REPOSITORY_PATH)} update-ref ${DEPLOYED_REF} FETCH_HEAD`,
      );
      await run(
        input.sandbox,
        `GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0 git -C ${quote(REPOSITORY_PATH)} fetch --no-tags --depth=${INITIAL_FETCH_DEPTH} origin ${quote(`refs/heads/${input.repository.targetBranch}`)}`,
      );
      await run(
        input.sandbox,
        `git -C ${quote(REPOSITORY_PATH)} update-ref ${BASE_REF} FETCH_HEAD`,
      );
      await deepenUntilRelated(input.sandbox, {
        base: input.repository.targetBranch,
        deployedSha: input.deployedSha,
      });
    },
  );
  const workspace = await readPreparedWorkspace(
    input.sandbox,
    input.deployedSha,
    input.rootDirectory,
  );
  await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} checkout --detach ${BASE_REF}`);
  await run(
    input.sandbox,
    `git -C ${quote(REPOSITORY_PATH)} worktree add --detach ${quote(DEPLOYED_PATH)} ${DEPLOYED_REF}`,
  );
  return workspace;
}

export async function readPreparedWorkspace(
  sandbox: SelfModificationCommandSandbox,
  deployedSha: string,
  rootDirectory: string,
): Promise<PreparedSelfModificationWorkspace> {
  assertFullSha(deployedSha, "deployed revision");
  assertRootDirectory(rootDirectory);
  const baseSha = await output(sandbox, `git -C ${quote(REPOSITORY_PATH)} rev-parse ${BASE_REF}`);
  assertFullSha(baseSha, "pull request base revision");
  const deployed = await output(
    sandbox,
    `git -C ${quote(REPOSITORY_PATH)} rev-parse ${DEPLOYED_REF}`,
  );
  assertFullSha(deployed, "workspace deployed revision");
  if (deployed !== deployedSha.toLowerCase())
    throw new Error(
      "Self-modification deployment source changed after the workspace was prepared.",
    );
  await run(
    sandbox,
    `git -C ${quote(REPOSITORY_PATH)} cat-file -e ${quote(`${deployed}^{commit}`)}`,
  );
  return {
    baseSha,
    deployedPath: DEPLOYED_PATH,
    deployedSha: deployed,
    repositoryPath: REPOSITORY_PATH,
    rootDirectory,
  };
}

export async function captureSelfModificationProposal(input: {
  readonly sandbox: SelfModificationCommandSandbox;
  readonly workspace: PreparedSelfModificationWorkspace;
}): Promise<SelfModificationProposal> {
  const { sandbox, workspace } = input;
  assertFullSha(workspace.baseSha, "proposal base revision");
  assertRootDirectory(workspace.rootDirectory);
  await run(
    sandbox,
    `git -C ${quote(workspace.repositoryPath)} read-tree ${quote(workspace.baseSha)}`,
  );
  await run(sandbox, `git -C ${quote(workspace.repositoryPath)} add -A -- .`);
  const proposedTreeSha = await output(
    sandbox,
    `git -C ${quote(workspace.repositoryPath)} write-tree`,
  );
  const baseTreeSha = await output(
    sandbox,
    `git -C ${quote(workspace.repositoryPath)} rev-parse ${quote(`${workspace.baseSha}^{tree}`)}`,
  );
  const raw = await output(
    sandbox,
    `git -C ${quote(workspace.repositoryPath)} diff-tree -r --no-commit-id --raw -z --no-renames ${quote(workspace.baseSha)} ${quote(proposedTreeSha)}`,
    false,
  );
  const records = parseRawDiff(raw);
  for (const record of records)
    if (!isSafeProposalPath(record.path))
      throw new Error(`Self-modification proposal may not change ${JSON.stringify(record.path)}.`);
  const excludedPaths = records
    .filter((record) => !isAllowedProposalPath(record.path, workspace.rootDirectory))
    .map((record) => record.path);
  if (excludedPaths.length > 0)
    throw new Error(
      `Self-modification proposal contains policy-excluded changes: ${summarizePaths(excludedPaths)}. Revert them before publishing.`,
    );
  if (records.length === 0) throw new Error("Self-modification proposal contains no changes.");
  if (records.length > MAX_CHANGED_FILES)
    throw new Error(
      `Self-modification proposal changes ${records.length} files; limit is ${MAX_CHANGED_FILES}.`,
    );
  const check = await sandbox.run({
    command: `git -C ${quote(workspace.repositoryPath)} diff --check ${quote(workspace.baseSha)} ${quote(proposedTreeSha)} --`,
  });
  const conflicts = String(check.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes("leftover conflict marker"));
  if (conflicts.length > 0)
    throw new Error(
      `Self-modification proposal contains conflict markers: ${conflicts.join("\n")}`,
    );
  const changes: ProposalChange[] = [];
  let changedBytes = 0;
  for (const record of records) {
    const mode = normalizeMode(record.status === "D" ? null : record.newMode, record.path);
    const objectId = record.status === "D" ? null : record.newObjectId;
    const size =
      objectId === null
        ? "0"
        : await output(
            sandbox,
            `git -C ${quote(workspace.repositoryPath)} cat-file -s ${quote(objectId)}`,
          );
    if (!/^\d+$/u.test(size))
      throw new Error(`Git returned an invalid blob size for ${JSON.stringify(record.path)}.`);
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes))
      throw new Error(`Git returned an invalid blob size for ${JSON.stringify(record.path)}.`);
    changedBytes += bytes;
    if (changedBytes > MAX_CHANGED_BYTES)
      throw new Error(`Self-modification proposal changes more than ${MAX_CHANGED_BYTES} bytes.`);
    changes.push({
      bytes,
      kind: record.status === "A" ? "add" : record.status === "D" ? "delete" : "modify",
      mode,
      objectId,
      path: record.path,
    });
  }
  return {
    baseSha: workspace.baseSha,
    baseTreeSha,
    changedBytes,
    changes,
    proposedTreeSha,
  };
}

/**
 * Reads one captured proposal blob out of the sandbox as base64.
 *
 * The sandbox runs model-controlled commands, so the bytes are re-hashed as a Git
 * blob and compared against the object id recorded during capture. That catches
 * truncated sandbox output and any substitution between capture and publication.
 */
export async function readProposalBlob(input: {
  readonly change: ProposalChange;
  readonly sandbox: SelfModificationCommandSandbox;
  readonly workspace: PreparedSelfModificationWorkspace;
}): Promise<string> {
  const { change } = input;
  if (change.objectId === null)
    throw new Error(
      `Self-modification cannot read a deleted blob for ${JSON.stringify(change.path)}.`,
    );
  assertFullSha(change.objectId, "proposal blob object id");
  const base64 = await output(
    input.sandbox,
    `git -C ${quote(input.workspace.repositoryPath)} cat-file blob ${quote(change.objectId)} | base64 | tr -d '\\n'`,
  );
  const bytes = Buffer.from(base64, "base64");
  const objectId = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.byteLength !== change.bytes || objectId !== change.objectId.toLowerCase())
    throw new Error(
      `Self-modification proposal blob for ${JSON.stringify(change.path)} changed after validation.`,
    );
  return base64;
}

interface RawDiffRecord {
  readonly newMode: string;
  readonly newObjectId: string;
  readonly path: string;
  readonly status: "A" | "D" | "M" | "T";
}
export function parseRawDiff(raw: string): RawDiffRecord[] {
  if (raw.length === 0) return [];
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git returned malformed raw diff output.");
  return fields.reduce<RawDiffRecord[]>((records, metadata, index) => {
    if (index % 2 !== 0) return records;
    const path = fields[index + 1]!;
    const matched = /^:[0-7]{6} ([0-7]{6}) [a-f0-9]{40} ([a-f0-9]{40}) ([ADMT])$/u.exec(metadata);
    if (matched === null || path.length === 0 || path.includes("\n") || path.includes("\r"))
      throw new Error("Git returned malformed raw diff output.");
    records.push({
      newMode: matched[1]!,
      newObjectId: matched[2]!,
      path,
      status: matched[3]! as RawDiffRecord["status"],
    });
    return records;
  }, []);
}
async function deepenUntilRelated(
  sandbox: SelfModificationCommandSandbox,
  refs: { readonly base: string; readonly deployedSha: string },
): Promise<void> {
  let depth = INITIAL_FETCH_DEPTH;
  while (!(await commandSucceeds(sandbox, ancestryCommand()))) {
    const shallow = await output(
      sandbox,
      `git -C ${quote(REPOSITORY_PATH)} rev-parse --is-shallow-repository`,
    );
    if (shallow !== "true")
      throw new Error(
        "The deployed revision is not an ancestor of the configured pull request base.",
      );
    if (depth >= MAX_FETCH_DEPTH)
      throw new Error(
        `Could not prove the deployed revision is an ancestor of the pull request base within ${MAX_FETCH_DEPTH} commits.`,
      );
    const deepenBy = Math.min(depth, MAX_FETCH_DEPTH - depth);
    await run(
      sandbox,
      `GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0 git -C ${quote(REPOSITORY_PATH)} fetch --no-tags --deepen=${deepenBy} origin ${quote(refs.deployedSha)} ${quote(`refs/heads/${refs.base}`)}`,
    );
    depth += deepenBy;
  }
}
function ancestryCommand(): string {
  return `git -C ${quote(REPOSITORY_PATH)} merge-base --is-ancestor ${DEPLOYED_REF} ${BASE_REF}`;
}
function checkoutNetworkPolicy(token: string): SandboxNetworkPolicy {
  return buildBrokerNetworkPolicy(token, ["github.com", "codeload.github.com"]);
}
function isAllowedProposalPath(path: string, rootDirectory: string): boolean {
  const agentRoot = rootDirectory === "." ? "agent/" : `${rootDirectory}/agent/`;
  return path.startsWith(agentRoot) && !isHardExcludedPath(path, rootDirectory);
}
function summarizePaths(paths: readonly string[]): string {
  const visible = paths.slice(0, 5).map((path) => JSON.stringify(path));
  const remaining = paths.length - visible.length;
  return remaining === 0 ? visible.join(", ") : `${visible.join(", ")} and ${remaining} more`;
}
function isSafeProposalPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}
function isHardExcludedPath(path: string, rootDirectory: string): boolean {
  const basename = path.split("/").at(-1) ?? "";
  const configPath =
    rootDirectory === "."
      ? SELF_MODIFICATION_CONFIG_PATH
      : `${rootDirectory}/${SELF_MODIFICATION_CONFIG_PATH}`;
  return (
    path === configPath ||
    path.startsWith(`${configPath}/`) ||
    path.split("/").some((segment) => [".next", "dist", "node_modules"].includes(segment)) ||
    basename === ".env" ||
    basename.startsWith(".env.")
  );
}
function assertRootDirectory(rootDirectory: string): void {
  if (
    rootDirectory !== "." &&
    (rootDirectory.length === 0 ||
      rootDirectory.startsWith("/") ||
      rootDirectory.includes("\\") ||
      rootDirectory
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === ".."))
  )
    throw new Error("Self-modification root directory is invalid.");
}
function normalizeMode(mode: string | null, path: string): "100644" | "100755" | null {
  if (mode === null || mode === "100644" || mode === "100755") return mode;
  throw new Error(
    `Self-modification proposal uses unsupported Git mode ${mode} for ${JSON.stringify(path)}.`,
  );
}
async function commandSucceeds(
  sandbox: SelfModificationCommandSandbox,
  command: string,
): Promise<boolean> {
  return (await sandbox.run({ command })).exitCode === 0;
}
async function output(
  sandbox: SelfModificationCommandSandbox,
  command: string,
  trim = true,
): Promise<string> {
  return await gitOutput(sandbox, command, trim);
}
async function run(sandbox: SelfModificationCommandSandbox, command: string): Promise<void> {
  await runGitCommand(sandbox, command);
}
function quote(value: string): string {
  return shellQuote(value);
}
