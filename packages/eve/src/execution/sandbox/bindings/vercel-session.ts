import {
  activateVercelEgressRules,
  type VercelEgressAuth,
  type VercelEgressDemand,
} from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import {
  clearVercelEgressDemandMarkers,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";
import type { TokenResult } from "#runtime/connections/types.js";
import type { VercelSandboxSessionUseOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export interface CreateVercelSandboxHandleInput {
  /** Credentials already activated in the sandbox policy by the attach. */
  readonly credentials?: ReadonlyMap<string, TokenResult>;
  readonly demand?: VercelEgressDemand;
  readonly egressAuth?: VercelEgressAuth;
  readonly sandbox: VercelSandbox;
  readonly sessionKey: string;
}

export function createVercelSandboxHandle(
  input: CreateVercelSandboxHandleInput,
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  const { demand, egressAuth, sandbox, sessionKey } = input;
  let credentials: ReadonlyMap<string, TokenResult> = new Map(input.credentials ?? []);
  const settleDemand =
    egressAuth === undefined || egressAuth.onRequestRuleIds.length === 0
      ? undefined
      : async (): Promise<void> => {
          const demanded = await readVercelEgressDemandedRuleIds(
            sandbox,
            egressAuth.onRequestRuleIds,
            demand?.token,
          );
          if (demanded.length === 0) return;
          const unresolved = demanded.filter((ruleId) => !credentials.has(ruleId));
          if (unresolved.length === 0) {
            await clearVercelEgressDemandMarkers(sandbox, demanded);
            return;
          }
          credentials = await activateVercelEgressRules({
            demand,
            demandedRuleIds: demanded,
            egressAuth,
            heldCredentials: credentials,
            ruleIds: unresolved,
            sandbox,
            sessionKey,
          });
        };
  const buildSession = () =>
    buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey, settleDemand),
      createVercelNetworkPolicySetter(sandbox, settleDemand !== undefined),
    );
  return {
    session: buildSession(),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        if (egressAuth !== undefined && options.networkPolicy !== undefined) {
          throw new Error(
            "vercel(): `onSession` cannot replace `networkPolicy` when managed `auth` rules exist.",
          );
        }
        await sandbox.update(options);
      }
      if (egressAuth !== undefined) {
        // Rebuild from the live credential set: demand may have settled
        // since attach, so a snapshot policy would drop those credentials.
        await sandbox.update({ networkPolicy: egressAuth.buildPolicy(credentials, demand) });
      }
      return buildSession();
    },
    async captureState() {
      const metadata: Record<string, unknown> = { sandboxName: sandbox.name };
      if (demand !== undefined) metadata.demandToken = demand.token;
      return {
        backendName: "vercel",
        metadata,
        sessionKey,
      };
    },
    async stop() {
      await stopVercelSandbox(sandbox);
    },
    async shutdown() {
      try {
        await stopVercelSandbox(sandbox);
      } catch {
        // Provider-side timeout is the backstop when the sandbox is unreachable.
      }
    },
    async revokeStepCredentials() {
      if (egressAuth !== undefined) {
        await sandbox.update({ networkPolicy: egressAuth.clearedPolicy });
      }
    },
  };
}

async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  await sandbox.stop();
}

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
  settleDemand?: () => Promise<void>,
): InternalSandboxSession {
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      const process = adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.stream,
      });
      if (settleDemand === undefined) return process;
      // A blocked request already failed inside the command (the egress proxy
      // answered 428), so the command exits on its own. One post-exit check
      // resolves the demanded credential — or raises the standard
      // authorization interrupt — and the model re-runs what it needs to.
      return {
        ...process,
        async wait() {
          const result = await process.wait();
          await settleDemand();
          return result;
        },
      };
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
  managedOnRequest = false,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    if (managedOnRequest) {
      throw new Error(
        "vercel(): `setNetworkPolicy()` cannot replace a policy with on-request `auth` rules.",
      );
    }
    await sandbox.update({ networkPolicy: policy });
  };
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
