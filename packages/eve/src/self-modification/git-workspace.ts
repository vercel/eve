import type { SandboxSession } from "eve/sandbox";

import { gitHubRemoteUrl } from "#shared/git.js";
import { shellQuote } from "#shared/shell-quote.js";

import type { GitHubRepository } from "./config.js";
import { gitOutput, runGitCommand, withBrokeredGitHubCredential } from "./git.js";
import { assertFullSha, assertGitRef } from "./identifiers.js";

export const SELF_MODIFICATION_CONFIG_PATH = "agent/subagents/self-modification/config.ts";
export const WORKSPACE_PATH = "/workspace";
export const REPOSITORY_PATH = `${WORKSPACE_PATH}/repository`;
export const BASE_REF = "refs/eve-self-modification/base";
const GIT_FETCH_ENV =
  "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_LFS_SKIP_SMUDGE=1 GIT_TERMINAL_PROMPT=0";

export interface PreparedSelfModificationWorkspace {
  readonly baseSha: string;
  readonly directory: string;
  readonly repository: GitHubRepository;
  readonly repositoryPath: string;
  readonly targetBranch: string;
}

type CheckoutSandbox = Pick<SandboxSession, "run" | "setNetworkPolicy">;

/** Prepares a token-free remote and immutable target-branch checkout for one child session. */
export async function prepareSelfModificationWorkspace(input: {
  readonly directory: string;
  readonly repository: GitHubRepository;
  readonly sandbox: CheckoutSandbox;
  readonly targetBranch: string;
  readonly token: string;
}): Promise<PreparedSelfModificationWorkspace> {
  assertGitRef(input.targetBranch, "target branch");
  const remote = gitHubRemoteUrl(input.repository);
  await withBrokeredGitHubCredential(input.sandbox, input.token, async () => {
    await run(
      input.sandbox,
      `rm -rf ${quote(REPOSITORY_PATH)} && mkdir -p ${quote(REPOSITORY_PATH)}`,
    );
    await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} init`);
    await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} remote add origin ${quote(remote)}`);
    await run(
      input.sandbox,
      `${GIT_FETCH_ENV} git -C ${quote(REPOSITORY_PATH)} fetch --no-tags origin ${quote(`refs/heads/${input.targetBranch}`)}`,
    );
    await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} update-ref ${BASE_REF} FETCH_HEAD`);
    await run(input.sandbox, `git -C ${quote(REPOSITORY_PATH)} checkout --detach ${BASE_REF}`);
  });
  const baseSha = await gitOutput(
    input.sandbox,
    `git -C ${quote(REPOSITORY_PATH)} rev-parse ${BASE_REF}`,
  );
  assertFullSha(baseSha, "target branch revision");
  await verifyApplicationRoot(input.sandbox, input.directory);
  return {
    baseSha,
    directory: input.directory,
    repository: input.repository,
    repositoryPath: REPOSITORY_PATH,
    targetBranch: input.targetBranch,
  };
}

/** Reconstructs trusted workspace metadata after the session checkout preflight. */
export async function readPreparedSelfModificationWorkspace(input: {
  readonly directory: string;
  readonly repository: GitHubRepository;
  readonly sandbox: Pick<SandboxSession, "run">;
  readonly targetBranch: string;
}): Promise<PreparedSelfModificationWorkspace> {
  const baseSha = await gitOutput(
    input.sandbox,
    `git -C ${quote(REPOSITORY_PATH)} rev-parse ${BASE_REF}`,
  );
  assertFullSha(baseSha, "target branch revision");
  await verifyApplicationRoot(input.sandbox, input.directory);
  return {
    baseSha,
    directory: input.directory,
    repository: input.repository,
    repositoryPath: REPOSITORY_PATH,
    targetBranch: input.targetBranch,
  };
}

export async function verifyApplicationRoot(
  sandbox: Pick<SandboxSession, "run">,
  directory: string,
): Promise<void> {
  const root = directory === "." ? REPOSITORY_PATH : `${REPOSITORY_PATH}/${directory}`;
  const result = await sandbox.run({ command: `test -d ${quote(`${root}/agent`)}` });
  if (result.exitCode !== 0) {
    throw new Error(`Self-modification source directory does not contain agent/: ${directory}`);
  }
}

function quote(value: string): string {
  return shellQuote(value);
}
async function run(sandbox: Pick<SandboxSession, "run">, command: string): Promise<void> {
  await runGitCommand(sandbox, command);
}
