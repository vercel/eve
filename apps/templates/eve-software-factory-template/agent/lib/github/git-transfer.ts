import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { FACTORY_BRANCH_PREFIX, FACTORY_REPO } from "../constants.js";
import {
  assertPushAuthority,
  ciScope,
  isCiIntake,
  isCiPull,
  isTicketIntake,
} from "../trust.js";
import { githubCredentials } from "./credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  REMOTE_URL,
  REPO_DIR,
  validateBranch,
} from "./git-remote.js";

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_PR_LOOKUP_BYTES = 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const BUNDLE = "/tmp/transfer.bundle";
const GIT_DIR = "/tmp/factory.git";
const COMMIT_SHA = /^[a-f0-9]{40}$/;

// Only object data crosses this boundary. Never reuse a station's snapshot,
// processes, environment, executable, hooks, or Git configuration here.
async function withRemote<T>(
  operation: (remote: Sandbox) => Promise<T>
): Promise<T> {
  const remote = await Sandbox.create({
    networkPolicy: "deny-all",
    runtime: "node24",
    timeout: 120_000,
  });
  try {
    const token = await mintInstallationToken(githubCredentials);
    await remote.updateNetworkPolicy(brokerPolicy(token));
    return await operation(remote);
  } finally {
    try {
      await remote.updateNetworkPolicy("deny-all");
    } finally {
      await remote.stop();
    }
  }
}

async function git(remote: Sandbox, args: string[]): Promise<string> {
  const result = await remote.runCommand("/usr/bin/env", [
    "-i",
    "PATH=/usr/bin:/bin",
    "HOME=/tmp",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_TERMINAL_PROMPT=0",
    "/usr/bin/git",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
  if (result.exitCode !== 0) {
    // Do not reflect remote output, which can contain repository-controlled data.
    throw new Error(
      "The isolated Git transfer failed. Check repository access and branch history."
    );
  }
  return (await result.stdout()).trim();
}

async function readBundle(
  stream: ReadableStream<Uint8Array> | null
): Promise<Buffer> {
  if (stream === null) {
    throw new Error("Git did not produce a transfer bundle.");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  await stream.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        length += chunk.byteLength;
        if (length > MAX_BUNDLE_BYTES) {
          throw new Error("Git transfer exceeds the 64 MiB bundle limit.");
        }
        chunks.push(chunk);
      },
    })
  );
  return Buffer.concat(chunks);
}

/** Import remote objects without ever lending credentials to repository code. */
export async function fetchRepository(
  station: SandboxSession,
  branch?: string
): Promise<string> {
  if (branch !== undefined) {
    const refusal = validateBranch(branch);
    if (refusal) {
      throw new Error(refusal);
    }
  }
  const bundle = await withRemote(async (remote) => {
    await git(remote, [
      "clone",
      "--bare",
      "--single-branch",
      ...(branch ? ["--branch", branch] : []),
      REMOTE_URL,
      GIT_DIR,
    ]);
    await git(remote, ["-C", GIT_DIR, "bundle", "create", BUNDLE, "--all"]);
    const stream = await remote.readFile(
      { path: BUNDLE },
      { signal: AbortSignal.timeout(120_000) }
    );
    return readBundle(
      stream === null
        ? null
        : (Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>)
    );
  });
  const path = `/tmp/factory-${randomUUID()}.bundle`;
  await station.writeBinaryFile({ content: bundle, path });
  const command = branch
    ? `git -C ${REPO_DIR} fetch '${path}' HEAD && git -C ${REPO_DIR} checkout -B '${branch}' FETCH_HEAD`
    : `git clone '${path}' ${REPO_DIR}`;
  const result = await station.run({ command });
  if (result.exitCode !== 0) {
    throw new Error("Could not import repository objects into the station.");
  }
  const head = await station.run({
    command: `git -C ${REPO_DIR} rev-parse HEAD`,
  });
  return String(head.stdout).trim();
}

async function readLookup(
  response: Response,
  signal: AbortSignal,
  limit = MAX_METADATA_BYTES
): Promise<unknown> {
  if (!response.ok || response.headers.has("link") || !response.body) {
    await response.body?.cancel();
    throw new Error("Unverifiable GitHub metadata.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  await response.body.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.byteLength;
        if (size > limit) {
          throw new Error("GitHub metadata exceeds the byte limit.");
        }
        chunks.push(chunk);
      },
    }),
    { signal }
  );
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function assertCiHeadAvailable(
  auth: SessionAuthContext | null
): Promise<void> {
  if (!isCiIntake(auth)) {
    return;
  }
  const scope = ciScope(auth);
  try {
    const token = await mintInstallationToken(githubCredentials);
    const signal = AbortSignal.timeout(15_000);
    const response = await fetch(
      `https://api.github.com/repos/${FACTORY_REPO}/pulls/${scope.pullNumber}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal,
      }
    );
    if (!isCiPull(await readLookup(response, signal), scope)) {
      throw new Error("Changed pull request authority.");
    }
  } catch {
    // biome-ignore lint/style/useErrorCause: transport errors may expose credentials or repository data
    throw new Error(
      "Could not verify CI pull request authority: an open draft on the same repository branch is required."
    );
  }
}

async function assertTicketHeadAvailable(
  branch: string,
  auth: SessionAuthContext | null
): Promise<void> {
  if (!isTicketIntake(auth)) {
    return;
  }
  let data: unknown[];
  try {
    const token = await mintInstallationToken(githubCredentials);
    const [owner] = FACTORY_REPO.split("/");
    const signal = AbortSignal.timeout(15_000);
    const pulls = await fetch(
      `https://api.github.com/repos/${FACTORY_REPO}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal,
      }
    );
    // Only an empty array permits delivery; full PR metadata is unnecessary.
    const parsed = await readLookup(pulls, signal, MAX_PR_LOOKUP_BYTES);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid pull requests.");
    }
    data = parsed;
  } catch {
    // biome-ignore lint/style/useErrorCause: transport errors may expose credentials or repository data
    throw new Error("Could not verify ticket branch pull requests.");
  }
  if (data.length !== 0) {
    throw new Error(
      "HTTP ticket branches cannot be pushed once a pull request exists."
    );
  }
}

async function assertPushTarget(
  branch: string,
  auth: SessionAuthContext | null
): Promise<void> {
  assertPushAuthority(branch, auth);
  const refusal = validateBranch(branch);
  if (refusal) {
    throw new Error(refusal);
  }
  if (!branch.startsWith(FACTORY_BRANCH_PREFIX)) {
    throw new Error("Pushes must target a factory feature branch.");
  }
  await assertTicketHeadAvailable(branch, auth);
  await assertCiHeadAvailable(auth);
  const token = await mintInstallationToken(githubCredentials);
  const signal = AbortSignal.timeout(15_000);
  const request = (path: string) =>
    fetch(`https://api.github.com/repos/${FACTORY_REPO}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal,
    });
  const repository = await request("");
  if (!repository.ok) {
    throw new Error(
      "Could not verify the factory repository's default branch."
    );
  }
  const metadata = (await readLookup(repository, signal)) as {
    default_branch?: string;
    id?: unknown;
  };
  if (isCiIntake(auth) && metadata.id !== ciScope(auth).repositoryId) {
    throw new Error("Could not verify CI factory repository identity.");
  }
  if (!metadata.default_branch || branch === metadata.default_branch) {
    throw new Error("Direct pushes to the default branch are not allowed.");
  }
  const target = await request(`/branches/${encodeURIComponent(branch)}`);
  if (
    target.status !== 404 &&
    (!target.ok ||
      ((await readLookup(target, signal)) as { protected?: boolean })
        .protected !== false)
  ) {
    throw new Error("Protected branches cannot be pushed by the factory.");
  }
}

/** Push exactly one validated ref from a fresh bare repository, without checkout. */
export async function pushBranch(
  station: SandboxSession,
  branch: string,
  auth: SessionAuthContext | null
): Promise<string> {
  await assertPushTarget(branch, auth);
  const path = `/tmp/factory-${randomUUID()}.bundle`;
  const result = await station.run({
    command: `git -C ${REPO_DIR} bundle create '${path}' 'refs/heads/${branch}'`,
    signal: AbortSignal.timeout(120_000),
  });
  if (result.exitCode !== 0) {
    throw new Error("Could not export the committed feature branch.");
  }
  const bundle = await readBundle(
    await station.readFile({ path, signal: AbortSignal.timeout(120_000) })
  );
  return withRemote(async (remote) => {
    await remote.writeFiles([{ content: bundle, path: BUNDLE }]);
    await git(remote, ["init", "--bare", GIT_DIR]);
    await git(remote, [
      "-C",
      GIT_DIR,
      "fetch",
      BUNDLE,
      `refs/heads/${branch}:refs/heads/transfer`,
    ]);
    const sha = await git(remote, [
      "-C",
      GIT_DIR,
      "rev-parse",
      "refs/heads/transfer^{commit}",
    ]);
    if (!COMMIT_SHA.test(sha)) {
      throw new Error("Invalid commit in Git transfer.");
    }
    // Keep the last authorization lookup after all station-controlled work.
    await assertTicketHeadAvailable(branch, auth);
    await assertCiHeadAvailable(auth);
    await git(remote, [
      "-C",
      GIT_DIR,
      "push",
      "--no-verify",
      REMOTE_URL,
      `${sha}:refs/heads/${branch}`,
    ]);
    return sha;
  });
}
