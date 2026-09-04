import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "#shared/shell-quote.js";

import type { PreparedSelfModificationWorkspace } from "../git-workspace.js";
import { gitOutput, runGitCommand } from "../git.js";
import { assertFullSha } from "../identifiers.js";
import { readTerminalHeadlessEvent } from "./eve-add.js";

const OFFICIAL_ADDRESS =
  /^(?:(?:channel|connection|extension|instrumentation)\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

export type ProductionRegistryInstallResult =
  | {
      readonly kind: "completed";
      readonly completedItems: readonly string[];
      readonly changedPaths: readonly string[];
      readonly deploymentRequired: boolean;
    }
  | { readonly kind: "input-required"; readonly installed: boolean; readonly question: unknown }
  | {
      readonly kind: "external-action-required";
      readonly installed: boolean;
      readonly message: string;
      readonly url: string;
      readonly userCode?: string;
    }
  | { readonly kind: "failed" | "cancelled"; readonly message: string };

export function assertOfficialRegistryAddress(address: string): void {
  if (!OFFICIAL_ADDRESS.test(address))
    throw new Error(
      "Production registry installation requires an exact official eve registry address.",
    );
}

/** Installs only official items and rolls back this invocation's tree on terminal failure. */
export async function installProductionRegistryItem(input: {
  readonly address: string;
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly installed?: boolean;
  readonly sandbox: Pick<SandboxSession, "run">;
  readonly signal?: AbortSignal;
  readonly workspace: PreparedSelfModificationWorkspace;
}): Promise<ProductionRegistryInstallResult> {
  assertOfficialRegistryAddress(input.address);
  const applicationRoot =
    input.workspace.directory === "."
      ? input.workspace.repositoryPath
      : `${input.workspace.repositoryPath}/${input.workspace.directory}`;
  const packageRoot = await locatePackageManagerRoot(
    input.sandbox,
    applicationRoot,
    input.workspace.repositoryPath,
    input.signal,
  );
  if (packageRoot === undefined)
    return { kind: "failed", message: "The proposal checkout has no supported lockfile." };
  if (
    !(await runChecked(
      input.sandbox,
      `mkdir -p ${quote(`${input.workspace.repositoryPath}/.git/info`)} && printf '\\nnode_modules/\\n**/node_modules/\\n' >> ${quote(`${input.workspace.repositoryPath}/.git/info/exclude`)}`,
      input.signal,
    )) ||
    !(await runChecked(input.sandbox, bootstrapCommand(packageRoot), input.signal))
  ) {
    return {
      kind: "failed",
      message: "Could not prepare the proposal checkout's locked dependencies.",
    };
  }
  const executable = await locateEveExecutable(
    input.sandbox,
    applicationRoot,
    packageRoot.root,
    input.signal,
  );
  if (executable === undefined)
    return {
      kind: "failed",
      message: "The proposal checkout's locked dependencies do not provide the eve CLI.",
    };
  const startingTree = await captureTree(input.sandbox, input.workspace.repositoryPath);
  if (input.answers !== undefined) {
    if (input.installed !== true) {
      return {
        kind: "failed",
        message: "Setup answers require a prior installed input-required result.",
      };
    }
    let probe: Awaited<ReturnType<typeof input.sandbox.run>>;
    try {
      probe = await input.sandbox.run({
        abortSignal: input.signal,
        command: isolatedCommand(
          applicationRoot,
          `${quote(executable)} add ${quote(input.address)} --non-interactive --skip-install`,
        ),
      });
    } finally {
      await restoreTree(input.sandbox, input.workspace.repositoryPath, startingTree);
    }
    const event = readTerminalHeadlessEvent(
      `${String(probe.stdout ?? "")}\n${String(probe.stderr ?? "")}`,
    );
    if (event?.type !== "blocked" || event.item !== input.address) {
      return {
        kind: "failed",
        message: "Setup continuation is no longer waiting for a validated question.",
      };
    }
    const question = setupQuestion(event.question);
    if (question === undefined) {
      return {
        kind: "failed",
        message: "Registry setup returned an invalid continuation question.",
      };
    }
    if (question.kind === "environment") {
      return { kind: "input-required", installed: true, question: event.question };
    }
    if (!acceptsNonSecretSetupAnswers(question, input.answers)) {
      return {
        kind: "failed",
        message: "Setup answers must contain only the current non-secret question.",
      };
    }
  }
  const answerArgs = Object.entries(input.answers ?? {}).flatMap(([key, value]) => [
    "--answer",
    `${key}=${JSON.stringify(value)}`,
  ]);
  try {
    const command = `${quote(executable)} add ${quote(input.address)} --non-interactive ${input.installed === true ? "--skip-install " : ""}${answerArgs.map(quote).join(" ")}`;
    const result = await input.sandbox.run({
      abortSignal: input.signal,
      command: isolatedCommand(applicationRoot, command),
    });
    const event = readTerminalHeadlessEvent(
      `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`,
    );
    if (event?.type === "completed" && event.item === input.address && result.exitCode === 0) {
      const resultingTree = await captureTree(input.sandbox, input.workspace.repositoryPath);
      return {
        kind: "completed",
        changedPaths: await changedPaths(
          input.sandbox,
          input.workspace.repositoryPath,
          startingTree,
          resultingTree,
        ),
        completedItems: event.completedItems?.filter((item) => OFFICIAL_ADDRESS.test(item)) ?? [],
        deploymentRequired: event.deploymentRequired === true,
      };
    }
    if (event?.type === "blocked" && event.item === input.address) {
      return {
        kind: "input-required",
        installed: event.installed === true,
        question: event.question ?? event,
      };
    }
    if (
      event?.type === "external_action" &&
      typeof event.url === "string" &&
      typeof event.message === "string"
    ) {
      return {
        kind: "external-action-required",
        installed: input.installed === true,
        message: event.message,
        url: event.url,
        ...(typeof event.userCode === "string" ? { userCode: event.userCode } : {}),
      };
    }
    await restoreTree(input.sandbox, input.workspace.repositoryPath, startingTree);
    return event?.type === "cancelled" || input.signal?.aborted === true
      ? { kind: "cancelled", message: `Installing ${input.address} was cancelled.` }
      : { kind: "failed", message: `Installing ${input.address} failed.` };
  } catch (error) {
    await restoreTree(input.sandbox, input.workspace.repositoryPath, startingTree);
    throw error;
  }
}

export function acceptsNonSecretSetupAnswers(
  question: { readonly key: string; readonly kind: string },
  answers: Readonly<Record<string, unknown>>,
): boolean {
  return (
    question.kind !== "environment" &&
    Object.keys(answers).length === 1 &&
    answers[question.key] !== undefined
  );
}

function setupQuestion(
  value: unknown,
): { readonly key: string; readonly kind: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const question = value as { key?: unknown; kind?: unknown; sensitive?: unknown };
  if (
    typeof question.key !== "string" ||
    question.key.length === 0 ||
    typeof question.kind !== "string"
  ) {
    return undefined;
  }
  return { key: question.key, kind: question.sensitive === true ? "environment" : question.kind };
}

interface PackageRoot {
  readonly kind: "npm" | "pnpm";
  readonly root: string;
}
export async function locatePackageManagerRoot(
  sandbox: Pick<SandboxSession, "run">,
  applicationRoot: string,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<PackageRoot | undefined> {
  const result = await sandbox.run({
    abortSignal: signal,
    command: `root=${quote(applicationRoot)}; repository=${quote(repositoryRoot)}; while :; do if test -f "$root/pnpm-lock.yaml"; then printf 'pnpm\\t%s' "$root"; exit 0; fi; if test -f "$root/package-lock.json"; then printf 'npm\\t%s' "$root"; exit 0; fi; test "$root" = "$repository" && exit 0; root=\${root%/*}; done`,
  });
  if (result.exitCode !== 0) throw new Error("Could not inspect the proposal package workspace.");
  const match = /^(pnpm|npm)\t([^\n]+)$/u.exec(String(result.stdout ?? ""));
  if (match === null) return undefined;
  const root = match[2]!;
  if (root !== repositoryRoot && !root.startsWith(`${repositoryRoot}/`))
    throw new Error("Package manager root escaped the proposal repository.");
  return { kind: match[1]! as PackageRoot["kind"], root };
}
export function bootstrapCommand(root: PackageRoot): string {
  return isolatedCommand(
    root.root,
    root.kind === "pnpm"
      ? `corepack pnpm --dir ${quote(root.root)} install --frozen-lockfile --ignore-scripts`
      : `npm ci --prefix ${quote(root.root)} --ignore-scripts`,
  );
}
async function locateEveExecutable(
  sandbox: Pick<SandboxSession, "run">,
  applicationRoot: string,
  packageRoot: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const candidates = [
    `${applicationRoot}/node_modules/.bin/eve`,
    `${packageRoot}/node_modules/.bin/eve`,
  ];
  const result = await sandbox.run({
    abortSignal: signal,
    command: `for executable in ${candidates.map(quote).join(" ")}; do if test -x "$executable"; then printf '%s' "$executable"; exit 0; fi; done`,
  });
  if (result.exitCode !== 0) throw new Error("Could not inspect the checkout's eve executable.");
  return candidates.includes(String(result.stdout ?? "")) ? String(result.stdout) : undefined;
}
async function captureTree(
  sandbox: Pick<SandboxSession, "run">,
  repository: string,
): Promise<string> {
  await runGitCommand(sandbox, `git -C ${quote(repository)} add -A -- .`);
  const tree = await gitOutput(sandbox, `git -C ${quote(repository)} write-tree`);
  assertFullSha(tree, "registry tree");
  return tree;
}
async function restoreTree(
  sandbox: Pick<SandboxSession, "run">,
  repository: string,
  tree: string,
): Promise<void> {
  await runGitCommand(sandbox, `git -C ${quote(repository)} read-tree --reset -u ${quote(tree)}`);
  await runGitCommand(sandbox, `git -C ${quote(repository)} clean -fd -- .`);
}
async function changedPaths(
  sandbox: Pick<SandboxSession, "run">,
  repository: string,
  before: string,
  after: string,
): Promise<readonly string[]> {
  const raw = await gitOutput(
    sandbox,
    `git -C ${quote(repository)} diff-tree -r --no-commit-id --name-only -z ${quote(before)} ${quote(after)}`,
    false,
  );
  return raw.split("\0").filter((path) => path.length > 0);
}
async function runChecked(
  sandbox: Pick<SandboxSession, "run">,
  command: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await sandbox.run({ abortSignal: signal, command })).exitCode === 0;
}
function isolatedCommand(cwd: string, command: string): string {
  return `env -i HOME=/tmp/eve-selfmod-home PATH=${SAFE_PATH} CI=1 npm_config_ignore_scripts=true sh -c ${quote(`cd ${quote(cwd)} && ${command}`)}`;
}
function quote(value: string): string {
  return shellQuote(value);
}
