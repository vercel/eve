import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { posix } from "node:path";

import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { createMicrosandboxWithProgress } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  applyMicrosandboxNetwork,
  createMicrosandboxNetworkPlan,
  createTransformBrokerEnvironment,
} from "#execution/sandbox/bindings/microsandbox-network.js";
import {
  MICROSANDBOX_USER,
  type ResolvedMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  type MicrosandboxSessionMetadata,
  writeSessionMetadata,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import {
  assertMicrosandboxPlatformCandidate,
  ensureMicrosandboxBaseRuntime,
} from "#execution/sandbox/bindings/microsandbox-platform.js";
import { adaptMicrosandboxExecToSandboxProcess } from "#execution/sandbox/bindings/microsandbox-process.js";
import {
  isEveDevEnvironment,
  loadOptionalEnginePackage,
} from "#internal/application/optional-package-install.js";
import { withDevelopmentSandboxTags } from "#execution/sandbox/development-run.js";
import type { SandboxBackendTags } from "#public/definitions/sandbox-backend.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";
import {
  isMicrosandboxNotFoundError,
  isMicrosandboxSnapshotSourceRunningError,
  isMicrosandboxStillRunningError,
  removeSnapshotIfExists,
  snapshotExists,
} from "#execution/sandbox/bindings/microsandbox-provider-state.js";
import type { Sandbox as MicrosandboxSandbox } from "microsandbox";

export {
  isMicrosandboxNotFoundError,
  removeSnapshotIfExists,
  sandboxExists,
  snapshotExists,
} from "#execution/sandbox/bindings/microsandbox-provider-state.js";

export type MicrosandboxModule = typeof import("microsandbox");

const MICROSANDBOX_PACKAGE_NAME = "microsandbox";
const MICROSANDBOX_CONNECT_TIMEOUT_MS = 10_000;
const MICROSANDBOX_STOP_TIMEOUT_MS = 10_000;

export class MicrosandboxVm {
  readonly #input: {
    readonly module: MicrosandboxModule;
    readonly options: ResolvedMicrosandboxOptions;
    readonly sessionKey: string;
    readonly tags?: SandboxBackendTags;
  };
  #metadataPath?: string;
  #networkPolicy?: SandboxNetworkPolicy;
  #optionsHash?: string;
  #sandbox: MicrosandboxSandbox;
  #sandboxName: string;
  #stateSnapshotName?: string;

  constructor(
    input: {
      readonly module: MicrosandboxModule;
      readonly options: ResolvedMicrosandboxOptions;
      readonly sessionKey: string;
      readonly tags?: SandboxBackendTags;
    },
    sandbox: MicrosandboxSandbox,
    sandboxName: string,
    networkPolicy: SandboxNetworkPolicy | undefined,
    metadataPath?: string,
    optionsHash?: string,
    stateSnapshotName?: string,
  ) {
    this.#input = input;
    this.#sandbox = sandbox;
    this.#sandboxName = sandboxName;
    this.#networkPolicy = networkPolicy;
    this.#metadataPath = metadataPath;
    this.#optionsHash = optionsHash;
    this.#stateSnapshotName = stateSnapshotName;
  }

  get id(): string {
    return this.#input.sessionKey;
  }

  async captureState(optionsHash: string): Promise<MicrosandboxSessionMetadata> {
    this.#optionsHash = optionsHash;
    if (isEveDevEnvironment()) {
      if (this.#metadataPath !== undefined) {
        await this.writeMetadata(this.#metadataPath, optionsHash);
      }
      return {
        networkPolicy: this.#networkPolicy,
        optionsHash,
        sandboxName: this.#sandboxName,
        stateSnapshotName: this.#stateSnapshotName,
        version: MICROSANDBOX_METADATA_VERSION,
      };
    }

    const previousStateSnapshotName = this.#stateSnapshotName;
    const stateSnapshotName = createProviderName(
      "eve-sbx-state",
      `${this.#input.sessionKey}:${randomUUID()}`,
    );

    await this.stopAndSnapshot(stateSnapshotName);
    this.#stateSnapshotName = stateSnapshotName;
    if (this.#metadataPath !== undefined) {
      await this.writeMetadata(this.#metadataPath, optionsHash);
    }
    if (previousStateSnapshotName !== undefined) {
      await removeSnapshotIfExists(this.#input.module, previousStateSnapshotName);
    }
    return {
      networkPolicy: this.#networkPolicy,
      optionsHash,
      sandboxName: this.#sandboxName,
      stateSnapshotName,
      version: MICROSANDBOX_METADATA_VERSION,
    };
  }

  async detach(): Promise<void> {
    await this.#sandbox.detach().catch(() => {});
  }

  /**
   * Stops the VM and releases the SDK client for server shutdown. The
   * stopped sandbox persists on disk, so a later `connect` restarts it
   * (dev) or restores from the last captured snapshot (production).
   */
  async shutdown(): Promise<void> {
    await this.#sandbox.stop().catch(() => {});
    await this.detach();
  }

  async readFileBytes(path: string): Promise<Buffer | null> {
    try {
      const fs = this.#sandbox.fs();
      if (!(await fs.exists(path))) {
        return null;
      }
      return Buffer.from(await fs.read(path));
    } catch {
      return null;
    }
  }

  async removePath(options: SandboxRemovePathOptions): Promise<void> {
    const flags = `${options.force === true ? "f" : ""}${options.recursive === true ? "r" : ""}`;
    const command = `${flags.length > 0 ? `rm -${flags}` : "rm"} -- ${shellQuote(options.path)}`;
    await this.runInternalCommand({
      abortSignal: options.abortSignal,
      command,
      user: MICROSANDBOX_USER,
    });
  }

  async removePersisted(): Promise<void> {
    await removeSandboxIfExists(this.#input.module, this.#sandboxName);
    if (this.#stateSnapshotName !== undefined) {
      await removeSnapshotIfExists(this.#input.module, this.#stateSnapshotName);
    }
  }

  async setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
    const previousStateSnapshotName = this.#stateSnapshotName;
    const stateSnapshotName = createProviderName(
      "eve-sbx-state",
      `${this.#input.sessionKey}:${randomUUID()}`,
    );
    const previousSandboxName = this.#sandboxName;

    await this.stopAndSnapshot(stateSnapshotName);
    await removeSandboxIfExists(this.#input.module, previousSandboxName);

    const nextSandboxName = createProviderName(
      "eve-sbx-ses",
      `${this.#input.sessionKey}:${randomUUID()}`,
    );
    this.#sandbox = await createMicrosandbox({
      fromSnapshot: stateSnapshotName,
      module: this.#input.module,
      name: nextSandboxName,
      networkPolicy: policy,
      options: this.#input.options,
      tags: this.#input.tags,
      user: MICROSANDBOX_USER,
      workdir: WORKSPACE_ROOT,
    });
    this.#sandboxName = nextSandboxName;
    this.#networkPolicy = policy;
    this.#stateSnapshotName = undefined;
    if (this.#metadataPath !== undefined && this.#optionsHash !== undefined) {
      await this.writeMetadata(this.#metadataPath, this.#optionsHash);
    }
    await removeSnapshotIfExists(this.#input.module, stateSnapshotName);
    if (previousStateSnapshotName !== undefined) {
      await removeSnapshotIfExists(this.#input.module, previousStateSnapshotName);
    }
  }

  async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    if (options.abortSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const env = {
      ...this.#input.options.env,
      ...createTransformBrokerEnvironment(createMicrosandboxNetworkPlan(this.#networkPolicy)),
      ...options.env,
    };

    const handle = await this.#sandbox.execStreamWith("bash", (builder) =>
      builder
        .args(["-lc", options.command])
        .cwd(options.workingDirectory ?? WORKSPACE_ROOT)
        .envs(env)
        .user(MICROSANDBOX_USER),
    );

    if (options.abortSignal !== undefined) {
      const kill = () => {
        void handle.kill().catch(() => {});
      };
      options.abortSignal.addEventListener("abort", kill, { once: true });
    }

    return adaptMicrosandboxExecToSandboxProcess(handle);
  }

  async stopAndSnapshot(snapshotName: string): Promise<void> {
    await this.#sandbox.stop().catch(() => {});
    await stopAndSnapshotMicrosandboxSandbox(this.#input.module, this.#sandboxName, snapshotName);
  }

  async writeFiles(
    files: ReadonlyArray<{ path: string; content: string | Uint8Array }>,
  ): Promise<void> {
    const fs = this.#sandbox.fs();
    for (const file of files) {
      const dir = posix.dirname(file.path);
      // Create parents as the sandbox user so every intermediate
      // directory is user-owned — a root-owned intermediate would make
      // the tree undeletable for `removePath`, which runs as the user.
      await this.runInternalCommand({
        command: `mkdir -p ${shellQuote(dir)}`,
        user: MICROSANDBOX_USER,
      });
      await fs.write(file.path, file.content);
      await this.runInternalCommand({
        command: `chown ${MICROSANDBOX_USER}:${MICROSANDBOX_USER} ${shellQuote(file.path)}`,
        user: "root",
      });
    }
  }

  async writeMetadata(path: string, optionsHash: string): Promise<void> {
    this.#metadataPath = path;
    this.#optionsHash = optionsHash;
    await writeSessionMetadata(path, {
      networkPolicy: this.#networkPolicy,
      optionsHash,
      sandboxName: this.#sandboxName,
      stateSnapshotName: this.#stateSnapshotName,
      version: MICROSANDBOX_METADATA_VERSION,
    });
  }

  private async runInternalCommand(input: {
    readonly abortSignal?: AbortSignal;
    readonly command: string;
    readonly failureMessage?: string;
    readonly user: string;
  }): Promise<void> {
    if (input.abortSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const output = await this.#sandbox.execWith("bash", (builder) =>
      builder.args(["-lc", input.command]).cwd(WORKSPACE_ROOT).user(input.user),
    );
    if (output.code !== 0) {
      const message = input.failureMessage ?? "Microsandbox command failed.";
      throw new Error(`${message} ${output.stderr()}`.trim());
    }
  }
}

export async function createPreparedMicrosandbox(input: {
  readonly fromSnapshot?: string;
  readonly log?: (message: string) => void;
  readonly module: MicrosandboxModule;
  readonly name: string;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly options: ResolvedMicrosandboxOptions;
  readonly sessionKey: string;
  readonly setupBaseRuntime: boolean;
  readonly tags?: SandboxBackendTags;
}): Promise<MicrosandboxVm> {
  const initialNetworkPolicy = input.setupBaseRuntime ? "allow-all" : input.networkPolicy;
  const sandbox = await createMicrosandbox({
    fromSnapshot: input.fromSnapshot,
    log: input.log,
    module: input.module,
    name: input.name,
    networkPolicy: initialNetworkPolicy,
    options: input.options,
    tags: input.tags,
    user: input.setupBaseRuntime ? undefined : MICROSANDBOX_USER,
    workdir: input.setupBaseRuntime ? "/" : WORKSPACE_ROOT,
  });

  const vm = new MicrosandboxVm(
    {
      module: input.module,
      options: input.options,
      sessionKey: input.sessionKey,
      tags: input.tags,
    },
    sandbox,
    input.name,
    initialNetworkPolicy,
  );

  if (input.setupBaseRuntime) {
    await withProgressHeartbeat("preparing base runtime inside VM", input.log, async () => {
      await ensureMicrosandboxBaseRuntime(sandbox, { log: input.log });
    });
    if (input.networkPolicy !== undefined && input.networkPolicy !== "allow-all") {
      input.log?.("applying network policy");
      await vm.setNetworkPolicy(input.networkPolicy);
    }
  }

  return vm;
}

export async function connectMicrosandbox(input: {
  readonly metadata: MicrosandboxSessionMetadata;
  readonly metadataPath: string;
  readonly module: MicrosandboxModule;
  readonly options: ResolvedMicrosandboxOptions;
  readonly sessionKey: string;
  readonly tags?: SandboxBackendTags;
}): Promise<MicrosandboxVm | null> {
  let handle;
  try {
    handle = await input.module.Sandbox.get(input.metadata.sandboxName);
  } catch (error) {
    if (!isMicrosandboxNotFoundError(error)) {
      throw error;
    }
    if (input.metadata.stateSnapshotName === undefined) {
      return null;
    }
    return await restoreMicrosandboxSessionSnapshot(input);
  }

  if (
    handle.status !== "running" &&
    handle.status !== "draining" &&
    input.metadata.stateSnapshotName !== undefined
  ) {
    return await restoreMicrosandboxSessionSnapshot(input);
  }

  const sandbox =
    handle.status === "running" || handle.status === "draining"
      ? await handle.connectWithTimeout(MICROSANDBOX_CONNECT_TIMEOUT_MS)
      : await handle.startDetached();

  return new MicrosandboxVm(
    {
      module: input.module,
      options: input.options,
      sessionKey: input.sessionKey,
      tags: input.tags,
    },
    sandbox,
    input.metadata.sandboxName,
    input.metadata.networkPolicy,
    input.metadataPath,
    input.metadata.optionsHash,
    input.metadata.stateSnapshotName,
  );
}

async function restoreMicrosandboxSessionSnapshot(input: {
  readonly metadata: MicrosandboxSessionMetadata;
  readonly metadataPath: string;
  readonly module: MicrosandboxModule;
  readonly options: ResolvedMicrosandboxOptions;
  readonly sessionKey: string;
  readonly tags?: SandboxBackendTags;
}): Promise<MicrosandboxVm | null> {
  if (
    input.metadata.stateSnapshotName === undefined ||
    !(await snapshotExists(input.module, input.metadata.stateSnapshotName))
  ) {
    return null;
  }

  const sandboxName = createProviderName("eve-sbx-ses", `${input.sessionKey}:${randomUUID()}`);
  const sandbox = await createMicrosandbox({
    fromSnapshot: input.metadata.stateSnapshotName,
    module: input.module,
    name: sandboxName,
    networkPolicy: input.metadata.networkPolicy,
    options: input.options,
    tags: input.tags,
    user: MICROSANDBOX_USER,
    workdir: WORKSPACE_ROOT,
  });
  await removeSandboxIfExists(input.module, input.metadata.sandboxName);

  const vm = new MicrosandboxVm(
    {
      module: input.module,
      options: input.options,
      sessionKey: input.sessionKey,
      tags: input.tags,
    },
    sandbox,
    sandboxName,
    input.metadata.networkPolicy,
    input.metadataPath,
    input.metadata.optionsHash,
    input.metadata.stateSnapshotName,
  );
  await vm.writeMetadata(input.metadataPath, input.metadata.optionsHash);
  return vm;
}

const MICROSANDBOX_MISSING_PACKAGE_MESSAGE =
  "The microsandbox sandbox backend requires the `microsandbox` package, which is not bundled " +
  "with eve. Install it in your application (for example `pnpm add -D microsandbox`), or use " +
  "docker() / vercel() instead.";

/**
 * Loads the microsandbox npm package and ensures its VM runtime is
 * installed. During `eve dev`, both are installed automatically when
 * missing (unless `setup.autoInstall: false`): the package with the
 * project's package manager, the runtime via microsandbox's installer.
 * Production processes never install — they fail with actionable
 * errors instead.
 */
export async function loadMicrosandboxModule(input: {
  readonly appRoot: string;
  readonly log?: (message: string) => void;
  readonly options: ResolvedMicrosandboxOptions;
}): Promise<MicrosandboxModule> {
  input.log?.("checking microsandbox platform support");
  await assertMicrosandboxPlatformCandidate();

  const module = await withProgressHeartbeat("loading microsandbox npm package", input.log, () =>
    loadOptionalEnginePackage<MicrosandboxModule>({
      appRoot: input.appRoot,
      autoInstall: input.options.setup.autoInstall,
      importModule: async () => await import("microsandbox"),
      missingMessage: MICROSANDBOX_MISSING_PACKAGE_MESSAGE,
      packageName: MICROSANDBOX_PACKAGE_NAME,
    }),
  );

  input.log?.("checking microsandbox VM runtime");
  if (!module.isInstalled()) {
    if (!input.options.setup.autoInstall || !isEveDevEnvironment()) {
      throw new Error(
        "The microsandbox VM runtime is not installed. Run `npx microsandbox install`, set " +
          "MSB_PATH for a custom install, or let `eve dev` install it automatically with " +
          "microsandbox({ setup: { autoInstall: true } }).",
      );
    }

    await withProgressHeartbeat("installing microsandbox VM runtime", input.log, async () => {
      await module.setup().skipVerify(input.options.setup.skipVerify).install();
    });
  }

  input.log?.("microsandbox runtime ready");
  return module;
}

async function withProgressHeartbeat<T>(
  message: string,
  log: ((message: string) => void) | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  log?.(message);
  if (log === undefined) {
    return await callback();
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    log(`${message} (${elapsedSeconds}s elapsed)`);
  }, 10_000);
  timer.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Loads microsandbox only when its package and runtime are already
 * present — used by cleanup paths that must never trigger installs.
 */
export async function loadMicrosandboxWithoutInstall(): Promise<MicrosandboxModule | null> {
  try {
    const module: MicrosandboxModule = await import("microsandbox");
    return module.isInstalled() ? module : null;
  } catch {
    return null;
  }
}

export async function stopAndSnapshotMicrosandboxSandbox(
  module: MicrosandboxModule,
  sandboxName: string,
  snapshotName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await module.Sandbox.get(sandboxName);
    await handle.stopWithTimeout(attempt === 0 ? MICROSANDBOX_STOP_TIMEOUT_MS : 0).catch(() => {});
    try {
      await handle.snapshot(snapshotName);
      return;
    } catch (error) {
      if (!isMicrosandboxSnapshotSourceRunningError(error) || attempt === 2) {
        throw error;
      }
      await handle.kill().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function createProviderName(prefix: string, key: string, extra = ""): string {
  const hash = createStableHash(`${key}:${extra}`).slice(0, 32);
  return `${prefix}-${hash}`;
}

export function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function doesPathExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createMicrosandbox(input: {
  readonly fromSnapshot?: string;
  readonly log?: (message: string) => void;
  readonly module: MicrosandboxModule;
  readonly name: string;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly options: ResolvedMicrosandboxOptions;
  readonly tags?: SandboxBackendTags;
  readonly user?: string;
  readonly workdir: string;
}): Promise<MicrosandboxSandbox> {
  let builder = input.module.Sandbox.builder(input.name)
    .cpus(input.options.cpus)
    .detached(true)
    .envs(input.options.env)
    .labels(resolveMicrosandboxLabels(input.tags))
    .memory(input.options.memoryMiB)
    .pullPolicy(input.options.pullPolicy)
    .replace()
    .workdir(input.workdir);

  if (input.fromSnapshot !== undefined) {
    builder = builder.fromSnapshot(input.fromSnapshot);
  } else {
    builder = builder.image(input.options.image);
  }

  if (input.user !== undefined) {
    builder = builder.user(input.user);
  }

  const source =
    input.fromSnapshot === undefined
      ? `image "${input.options.image}"`
      : `snapshot "${input.fromSnapshot}"`;
  return await createMicrosandboxWithProgress({
    builder: applyMicrosandboxNetwork(builder, input.networkPolicy),
    errorType: input.module.MicrosandboxError,
    log: input.log,
    source,
  });
}

async function removeSandboxIfExists(
  module: MicrosandboxModule,
  sandboxName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await module.Sandbox.get(sandboxName);
      await handle
        .stopWithTimeout(attempt === 0 ? MICROSANDBOX_STOP_TIMEOUT_MS : 0)
        .catch(() => {});
      await handle.remove();
      return;
    } catch (error) {
      if (isMicrosandboxNotFoundError(error)) {
        return;
      }

      if (isMicrosandboxStillRunningError(error) && attempt < 2) {
        const handle = await module.Sandbox.get(sandboxName).catch(() => null);
        await handle?.kill().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      throw error;
    }
  }
}

function resolveMicrosandboxLabels(tags: SandboxBackendTags | undefined): Record<string, string> {
  return {
    "eve.backend": "microsandbox",
    ...withDevelopmentSandboxTags(tags),
  };
}
